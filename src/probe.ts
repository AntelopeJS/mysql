import net from "node:net";
import {
  type Connection as DriverConnection,
  type RowDataPacket,
  createConnection,
} from "mysql2";
import type {
  Probe,
  ProbeAnswer,
  ProbeRefusal,
} from "@antelopejs/interface-database-catalog";

import { MODULE_POOL_OPTIONS } from "./config";
import { ParseRow, PreparesOn, ReadRows, type Row } from "./connection";
import type { Session } from "./session";
import { DIALECTS, DetectDialect } from "./dialect";
import { IsString } from "./implementations/database/guards";
import {
  Confirmed,
  Deletes,
  ReadRelationAccess,
} from "./implementations/database/external-catalog";
import type { RelationAccess } from "./dialect/external";
import { ProbeTarget } from "./probe-options";
import { Bind, int, type Sql, sql } from "./statement";

const ACCESS_DENIED = "ER_ACCESS_DENIED_ERROR";

/** The refusal of each server error a person can act on, by the code `mysql2` gives it; any other `ER_*` is `other`. */
const REFUSALS: ReadonlyMap<string, ProbeRefusal> = new Map([
  [ACCESS_DENIED, "credentials"],
  ["ER_HOST_NOT_PRIVILEGED", "host"],
  ["ER_BAD_DB_ERROR", "database"],
  ["ER_DBACCESS_DENIED_ERROR", "database-denied"],
]);

const SERVER_ERROR = "ER_";

/** The codes of a connection that ended under the probe: no server answer follows them. */
const LOST: ReadonlySet<string> = new Set([
  "PROTOCOL_CONNECTION_LOST",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
]);

/**
 * How far the sign-in went: no word from a server yet, a server's greeting, or the account signed
 * in. A sign-in that fails after the greeting, short of a lost connection or a timeout, is one the
 * server answered in a way the probe cannot complete: an authentication plugin `mysql2` lacks, a
 * password in clear, TLS the server does not offer or a certificate that fails.
 */
type Stage = "connecting" | "greeted" | "signed-in";

const ACCOUNT = sql`SELECT CURRENT_USER() AS account, DATABASE() AS current_database, VERSION() AS version`;

const ABORTED = "The probe was aborted.";

/** The message of a failure that says nothing and carries no code. */
const UNSAID = "the connection failed without a message";

const MS_PER_SECOND = 1000;

/**
 * Bounds how long a statement of the probe waits for a lock, a metadata lock among them: one
 * second past the probe's own timeout, so the probe answers first, and the server ends the wait
 * soon after the probe has gone. MySQL notices a closed client only once the wait ends.
 */
function LockWait(timeoutMs: number): Sql {
  return sql`SET SESSION lock_wait_timeout = ${int(Math.ceil(timeoutMs / MS_PER_SECOND) + 1)}`;
}

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

/**
 * What a failure says, never empty. Node fails a host name with several addresses, such as
 * `localhost`, with an `AggregateError` whose own message is empty, so its errors speak for it.
 */
function MessageOf(error: unknown): string {
  const message =
    error instanceof AggregateError && error.message === ""
      ? error.errors.map(MessageOf).join("; ")
      : error instanceof Error
        ? error.message
        : String(error);
  return message === "" ? (CodeOf(error) ?? UNSAID) : message;
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
  config: {
    host: string;
    port: number;
    socketPath?: string;
    localAddress?: string;
    enableKeepAlive: boolean;
    keepAliveInitialDelay: number;
  };
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
  stage: Stage = "connecting";

  constructor(
    uri: string,
    readonly timeoutMs: number,
    private readonly signal: AbortSignal,
  ) {
    const options = {
      ...MODULE_POOL_OPTIONS,
      flags: [...MODULE_POOL_OPTIONS.flags],
      connectTimeout: timeoutMs,
      enableCleartextPlugin: false,
      stream: ({ config }: StreamRequest) => {
        const socket = config.socketPath
          ? net.connect(config.socketPath)
          : net.connect({
              port: config.port,
              host: config.host,
              localAddress: config.localAddress,
            });
        socket.setNoDelay(true);
        if (config.enableKeepAlive) {
          socket.setKeepAlive(true, config.keepAliveInitialDelay);
        }
        socket.once("data", () => {
          this.stage = this.stage === "connecting" ? "greeted" : this.stage;
        });
        this.sockets.push(socket);
        return socket;
      },
    };
    this.connection = createConnection({ ...options, uri });
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

  /**
   * Says goodbye, and shuts the sockets once it has gone out, or after the timeout when it has not.
   * `mysql2` settles its `end` before it writes the goodbye, so the sockets end on the next turn.
   */
  close(): void {
    const timer = setTimeout(this.destroy, this.timeoutMs);
    timer.unref();
    this.connection.end(() => {
      setImmediate(() => {
        for (const socket of this.sockets) {
          socket.end(this.destroy);
        }
      });
    });
  }
}

/** Whether the account may insert, update or delete in any of the relations, as the catalog decides each. */
async function AnyWrite(
  session: Session,
  rows: readonly RelationAccess[],
): Promise<boolean> {
  for (const row of rows.filter((listed) => listed.insert || listed.update)) {
    const confirmed = await Confirmed(session, row);
    if (confirmed.insert || confirmed.update) {
      return true;
    }
  }
  for (const row of rows) {
    if (await Deletes(session, row)) {
      return true;
    }
  }
  return false;
}

/** Whether the account may read any of the relations, as the catalog confirms each, or sees none. */
async function AnyRead(
  session: Session,
  rows: readonly RelationAccess[],
): Promise<boolean> {
  if (rows.length === 0) {
    return true;
  }
  for (const row of rows.filter((listed) => listed.readable)) {
    if ((await Confirmed(session, row)).readable) {
      return true;
    }
  }
  return false;
}

/** Signs in, reads the account, and decides what it may do with the relations of the URL's database. */
async function Inspect(line: Line): Promise<ProbeAnswer> {
  const client = line.connection.promise();
  await line.answer(client.connect());
  line.stage = "signed-in";
  const started = performance.now();
  const [cells] = await line.answer(
    client.query<RowDataPacket[]>(Bind(ACCOUNT).sql),
  );
  const account = cells[0] && ParseRow(Object.entries(cells[0]));
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
    await line.answer(client.query(Bind(LockWait(line.timeoutMs)).sql));
    const session = line.session(dialect);
    const rows = await ReadRelationAccess(session, [database]);
    return {
      ...signedIn,
      canRead: await AnyRead(session, rows),
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

/**
 * Why the server refused the sign-in. A refused account the URL gives no password for is
 * `sign-in-required`, as the server wants a password the URL does not give.
 */
function RefusalOf(code: string, passwordGiven: boolean): ProbeRefusal {
  if (code === ACCESS_DENIED && !passwordGiven) {
    return "sign-in-required";
  }
  return REFUSALS.get(code) ?? "other";
}

/** A failure, given how far the sign-in went: a refusal the server answered, one it made by how it answered, else no answer at all. */
function Failed(
  error: unknown,
  passwordGiven: boolean,
  stage: Stage,
): ProbeAnswer {
  const code = CodeOf(error);
  const message = MessageOf(error);
  if (code?.startsWith(SERVER_ERROR)) {
    return {
      outcome: "refused",
      refusal: RefusalOf(code, passwordGiven),
      message,
    };
  }
  const lost =
    error instanceof Unanswered || (code !== undefined && LOST.has(code));
  if (stage === "greeted" && !lost) {
    return { outcome: "refused", refusal: "other", message };
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
    const target = ProbeTarget(url);
    if ("refused" in target) {
      return {
        outcome: "refused",
        refusal: "other",
        message: `The probe does not take the URL option ${target.refused}.`,
      };
    }
    line = new Line(target.uri, timeoutMs, signal);
  } catch (error) {
    return Failed(error, true, "connecting");
  }
  let answer: ProbeAnswer;
  try {
    answer = await Inspect(line);
  } catch (error) {
    answer = Failed(
      error,
      Boolean(line.connection.config.password),
      line.stage,
    );
  }
  if (answer.outcome === "unreachable") {
    line.destroy();
  } else {
    line.close();
  }
  return answer;
};
