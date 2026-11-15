import net from "node:net";
import { type Connection as DriverConnection, createConnection } from "mysql2";
import type {
  Probe,
  ProbeAnswer,
  ProbeRefusal,
} from "@antelopejs/interface-database-catalog";

import { MODULE_POOL_OPTIONS } from "./config";
import { PreparesOn, ReadRows, type Row } from "./connection";
import type { Session } from "./session";
import { DIALECTS, DetectDialect } from "./dialect";
import { IsString } from "./implementations/database/guards";
import {
  ReadRelationRows,
  WritesOf,
} from "./implementations/database/external-catalog";
import type { RelationRow } from "./dialect/external";
import { Bind, sql } from "./statement";

/** The refusal of each server error a person can act on, by the code `mysql2` gives it; any other `ER_*` is `other`. */
const REFUSALS: ReadonlyMap<string, ProbeRefusal> = new Map([
  ["ER_ACCESS_DENIED_ERROR", "credentials"],
  ["ER_HOST_NOT_PRIVILEGED", "host"],
  ["ER_BAD_DB_ERROR", "database"],
  ["ER_DBACCESS_DENIED_ERROR", "database-denied"],
]);

const SERVER_ERROR = "ER_";

const ACCOUNT = sql`SELECT CURRENT_USER() AS account, DATABASE() AS current_database, VERSION() AS version`;

const ABORTED = "The probe was aborted.";

/** What a probe answers once its signal has aborted. */
function Aborted(): ProbeAnswer {
  return { outcome: "unreachable", message: ABORTED };
}

/** A step the server did not answer within the timeout, or one the caller's signal ended. */
class Unanswered extends Error {}

/** The code `mysql2` gives an error: `ER_*` for one the server answered, a Node code for one of the network. */
function CodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) {
    return undefined;
  }
  return IsString(error.code) ? error.code : undefined;
}

function MessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Text(row: Row | undefined, column: string): string | undefined {
  const cell = row?.get(column);
  if (cell === null || cell === undefined) {
    return undefined;
  }
  return Buffer.isBuffer(cell) ? cell.toString("utf8") : String(cell);
}

/** What `mysql2` passes its stream factory: where to connect, as it read the URL. */
interface StreamRequest {
  config: { host: string; port: number; socketPath?: string };
}

type SignedIn = Extract<ProbeAnswer, { outcome: "signed-in" }>;

/**
 * The one connection a probe opens, and every socket `mysql2` connected it through. `mysql2`'s
 * `destroy` only ends the socket's writing side, and its `end` settles before the server has
 * closed its own, so the line keeps the sockets to shut them.
 */
class Line {
  readonly connection: DriverConnection;
  private readonly sockets: net.Socket[] = [];
  private shut = false;

  constructor(
    url: string,
    private readonly timeoutMs: number,
    private readonly signal: AbortSignal,
  ) {
    this.connection = createConnection({
      ...MODULE_POOL_OPTIONS,
      flags: [...MODULE_POOL_OPTIONS.flags],
      uri: url,
      connectTimeout: timeoutMs,
      stream: ({ config }: StreamRequest) => {
        const socket = config.socketPath
          ? net.connect(config.socketPath)
          : net.connect(config.port, config.host);
        this.sockets.push(socket);
        return socket;
      },
    });
    this.connection.on("error", () => undefined);
    signal.addEventListener("abort", this.destroy, { once: true });
  }

  /** `work`, unless the server takes longer than the timeout to answer or the signal aborts first. */
  answer<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Unanswered(`timed out: no answer within ${this.timeoutMs} ms`),
        );
      }, this.timeoutMs);
      const abort = () => reject(new Unanswered(ABORTED));
      this.signal.addEventListener("abort", abort, { once: true });
      work.then(resolve, reject).finally(() => {
        clearTimeout(timer);
        this.signal.removeEventListener("abort", abort);
      });
    });
  }

  /** The line as the catalog reads relations on, each statement bounded as {@link answer} bounds it. */
  session(dialect: Session["dialect"]): Session {
    const client = this.connection.promise();
    return {
      dialect,
      read: (statement) => this.answer(ReadRows(client, statement)),
      prepares: (statement) =>
        this.answer(PreparesOn(client, dialect, statement)),
    };
  }

  /** Shuts every socket at once. */
  readonly destroy = (): void => {
    if (this.shut) {
      return;
    }
    this.shut = true;
    this.signal.removeEventListener("abort", this.destroy);
    for (const socket of this.sockets) {
      socket.destroy();
    }
  };

  /** Says goodbye, and shuts the sockets once `mysql2` has, or after the timeout when it has not. */
  close(): void {
    const timer = setTimeout(this.destroy, this.timeoutMs);
    timer.unref();
    this.connection.end(() => {
      clearTimeout(timer);
      this.destroy();
    });
  }
}

/** Whether the account may insert, update or delete in any of the relations, as the catalog decides each. */
async function AnyWrite(
  session: Session,
  rows: readonly RelationRow[],
): Promise<boolean> {
  for (const row of rows) {
    const writes = await WritesOf(session, row);
    if (writes.insert || writes.update || writes.delete) {
      return true;
    }
  }
  return false;
}

/** Signs in, reads the account, and decides what it may do with the relations of the URL's database. */
async function Inspect(line: Line): Promise<ProbeAnswer> {
  const client = line.connection.promise();
  await line.answer(client.connect());
  const started = performance.now();
  const [account] = await line.answer(ReadRows(client, ACCOUNT));
  const signedIn: Pick<SignedIn, "outcome" | "latencyMs" | "user"> = {
    outcome: "signed-in",
    latencyMs: Math.ceil(performance.now() - started),
    user: Text(account, "account"),
  };
  const database = Text(account, "current_database");
  if (database === undefined) {
    return {
      ...signedIn,
      canRead: false,
      canWrite: false,
      unreadable: "no-database-named",
    };
  }
  const dialect = DIALECTS[DetectDialect(Text(account, "version") ?? "")];
  try {
    await line.answer(client.query(Bind(dialect.session.pin({})).sql));
    const session = line.session(dialect);
    const rows = await ReadRelationRows(session, [database]);
    return {
      ...signedIn,
      canRead: rows.length === 0 || rows.some((row) => row.readable),
      canWrite: await AnyWrite(session, rows),
    };
  } catch (error) {
    if (!CodeOf(error)?.startsWith(SERVER_ERROR)) {
      throw error;
    }
    return {
      ...signedIn,
      canRead: false,
      canWrite: false,
      unreadable: "cannot-list",
    };
  }
}

/** A failure before the account signed in: a refusal the server answered, else no answer at all. */
function Failed(error: unknown): ProbeAnswer {
  const code = CodeOf(error);
  const message = MessageOf(error);
  if (code?.startsWith(SERVER_ERROR)) {
    return {
      outcome: "refused",
      refusal: REFUSALS.get(code) ?? "other",
      message,
    };
  }
  return { outcome: "unreachable", message };
}

/**
 * Signs in to the MySQL or MariaDB server of a `mysql://` URL and answers what the account may do
 * with the relations of the URL's database, deciding each relation as the catalog does. It runs
 * no statement that writes, and never rejects. It closes its connection once it has answered; on
 * an answer of no server it shuts the socket at once. When `signal` aborts before it has settled,
 * or has aborted already, it shuts every socket it opened, opening none in the second case, and
 * answers {@link Aborted} at once, whatever the server answered so far.
 */
export const probe: Probe = async ({ url, timeoutMs, signal }) => {
  if (signal.aborted) {
    return Aborted();
  }
  let line: Line;
  try {
    line = new Line(url, timeoutMs, signal);
  } catch (error) {
    return Failed(error);
  }
  let answer: ProbeAnswer;
  try {
    answer = await Inspect(line);
  } catch (error) {
    answer = Failed(error);
  }
  if (signal.aborted) {
    line.destroy();
    return Aborted();
  }
  if (answer.outcome === "unreachable") {
    line.destroy();
  } else {
    line.close();
  }
  return answer;
};
