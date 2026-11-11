import type { PoolConnection, ResultSetHeader } from "mysql2/promise";

import { Logger } from "../../logger";
import { Bind, type Sql } from "../../statement";
import type { DdlFailure } from "../../dialect";
import {
  AcquireConnection,
  GetDialect,
  Read,
  type Row,
} from "../../connection";

/**
 * How long a DDL statement waits for a metadata lock. Short on purpose: while an `ALTER` waits, every
 * later statement on its table queues behind it, so a wait that times out is retried instead.
 */
const DDL_LOCK_WAIT_SECONDS = 5;

/** How long one wait for the tables lock lasts before the waiter asks again, and says it waits. */
const TABLES_LOCK_WAIT_SECONDS = 10;

/** How many times a step that timed out on a lock is tried before convergence gives up on it. */
export const LOCK_ATTEMPTS = 6;

const RETRY_BASE_MS = 100;

/** A dedicated connection convergence runs its statements on, one at a time. */
export interface ConvergenceSession {
  /** The server's id of the connection, which `KILL QUERY` names. */
  readonly id: number;
  read(statement: Sql): Promise<Row[]>;
  /** Runs a statement through the text protocol, as DDL needs; answers the rows it matched. */
  apply(statement: Sql): Promise<number>;
  /** Runs a data change through the prepared protocol; answers the rows it matched. */
  write(statement: Sql): Promise<number>;
}

/** What a failed statement means; anything thrown that is not an `Error` broke the session. */
export function FailureOf(cause: unknown): DdlFailure {
  return cause instanceof Error ? GetDialect().ddl.failure(cause) : "broken";
}

/** The pause before attempt `attempt + 1` of a step that timed out on a lock. */
export function RetryDelayMs(attempt: number): number {
  return RETRY_BASE_MS * 2 ** attempt;
}

/** Statements on `connection`, which the caller holds. */
export function SessionOf(connection: PoolConnection): ConvergenceSession {
  return {
    id: connection.threadId,
    read: (statement) => Read(statement, connection),
    apply: async (statement) => {
      const bound = Bind(statement);
      const [result] = await connection.query<ResultSetHeader>(bound.sql, [
        ...bound.args,
      ]);
      return result.affectedRows;
    },
    write: async (statement) => {
      const bound = Bind(statement);
      const [result] = await connection.execute<ResultSetHeader>(bound.sql, [
        ...bound.args,
      ]);
      return result.affectedRows;
    },
  };
}

/**
 * Runs `work` on a connection of its own. A failure destroys the connection rather than returning it
 * to the pool, which ends its session and with it every named lock and setting the work left on it.
 */
async function OnDedicatedSession<T>(
  work: (session: ConvergenceSession) => Promise<T>,
): Promise<T> {
  const connection = await AcquireConnection();
  try {
    const result = await work(SessionOf(connection));
    connection.release();
    return result;
  } catch (err) {
    connection.destroy();
    throw err;
  }
}

const queues = new Map<string, Promise<void>>();

/**
 * Runs `work` once every earlier call with the same key has settled. A process converging one
 * schema twice at once thus holds one connection for it, not one per waiter.
 */
function Serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.then(work);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) {
      queues.delete(key);
    }
  });
  return result;
}

/** A lock name scoped to the connected database, since named locks are server-wide. */
async function LockName(
  session: ConvergenceSession,
  purpose: string,
  schemaKey: string,
): Promise<string> {
  const dialect = GetDialect();
  const [row] = await session.read(dialect.catalog.readDatabase());
  const database = row?.get("name") ?? "";
  return dialect.session.lockName(purpose, `${String(database)}/${schemaKey}`);
}

async function TakeLock(
  session: ConvergenceSession,
  name: string,
  waitSeconds: number,
): Promise<boolean> {
  const [row] = await session.read(
    GetDialect().session.acquireLock(name, waitSeconds),
  );
  const acquired = row?.get("acquired");
  if (acquired === null || acquired === undefined) {
    throw new Error(`The server could not take the named lock '${name}'`);
  }
  return Number(acquired) === 1;
}

async function WaitForLock(
  session: ConvergenceSession,
  name: string,
  schemaKey: string,
): Promise<void> {
  let waited = false;
  while (!(await TakeLock(session, name, TABLES_LOCK_WAIT_SECONDS))) {
    if (!waited) {
      Logger.Info(
        `waiting for another process converging the tables of schema '${schemaKey}'`,
      );
      waited = true;
    }
  }
}

/** Holds `name` on the session for `work`, with DDL waits bounded, then gives both back. */
async function Holding<T>(
  session: ConvergenceSession,
  name: string,
  work: (session: ConvergenceSession) => Promise<T>,
): Promise<T> {
  const dialect = GetDialect();
  await session.apply(dialect.ddl.lockWait(DDL_LOCK_WAIT_SECONDS));
  const result = await work(session);
  await session.apply(dialect.ddl.lockWait(undefined));
  await session.read(dialect.session.releaseLock(name));
  return result;
}

/**
 * Runs the tables phase of a schema under its tables lock, which every process converging that
 * schema takes in turn: the one that goes second reads the catalog the first left, and finds
 * nothing left to do. Waits as long as the holder works; a holder that dies releases the lock with
 * its session.
 */
export function WithTablesLock<T>(
  schemaKey: string,
  work: (session: ConvergenceSession) => Promise<T>,
): Promise<T> {
  return Serialized(schemaKey, () =>
    OnDedicatedSession(async (session) => {
      const name = await LockName(session, "tables", schemaKey);
      await WaitForLock(session, name, schemaKey);
      return Holding(session, name, work);
    }),
  );
}

/**
 * Runs the index phase of a schema under its indexes lock, or answers `undefined` without running
 * it when another session holds the lock: that session is building the same indexes.
 */
export function WithIndexesLock<T>(
  schemaKey: string,
  work: (session: ConvergenceSession) => Promise<T>,
): Promise<T | undefined> {
  return OnDedicatedSession(async (session) => {
    const name = await LockName(session, "indexes", schemaKey);
    if (!(await TakeLock(session, name, 0))) {
      return undefined;
    }
    return Holding(session, name, work);
  });
}

/** Stops whatever statement `session` is running, from a pooled connection. */
export async function Interrupt(session: ConvergenceSession): Promise<void> {
  await OnDedicatedSession((pooled) =>
    pooled.apply(GetDialect().ddl.killQuery(session.id)),
  );
}
