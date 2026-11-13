import { setTimeout as delay } from "node:timers/promises";
import type { PoolConnection, ResultSetHeader } from "mysql2/promise";

import { Logger } from "../../logger";
import { Bind, type Sql } from "../../statement";
import type { DdlFailure } from "../../dialect";
import {
  AcquireConnection,
  GetDialect,
  Read,
  type Row,
  Uncapped,
} from "../../connection";

/**
 * How long a DDL statement waits for a metadata lock. Short on purpose: while an `ALTER` waits, every
 * later statement on its table queues behind it, so a wait that times out is retried instead.
 */
const DDL_LOCK_WAIT_SECONDS = 5;

/** How long a phase pauses between two attempts at a convergence lock another session holds. */
const LOCK_RETRY_MS = 1000;

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
      const bound = Bind(Uncapped(statement));
      const [result] = await connection.query<ResultSetHeader>(bound.sql, [
        ...bound.args,
      ]);
      return result.affectedRows;
    },
    write: async (statement) => {
      const bound = Bind(Uncapped(statement));
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
export async function OnDedicatedSession<T>(
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

/** A convergence phase, which runs under a named lock of its own per schema. */
type Phase = "tables" | "indexes";

/** What a waiting phase says the other process is doing. */
const HOLDER_WORK: Record<Phase, string> = {
  tables: "converging the tables",
  indexes: "building the indexes",
};

/** What a phase tells the lock it runs under. */
export interface PhaseHooks {
  /** Runs on the session of each attempt at the lock, before the attempt tries it. */
  readonly opened?: (session: ConvergenceSession) => Promise<void>;
  /** Ends the phase before its next attempt, and cuts short the pause before it. */
  readonly stop?: AbortSignal;
  /**
   * Decides, once an attempt failed with `cause`, whether the phase tries again, and pauses as long
   * as it needs first. The phase keeps its turn meanwhile, so a later call for the same schema still
   * runs after it.
   */
  readonly again?: (cause: unknown) => Promise<boolean>;
}

/** One attempt at a lock: what the work answered, or nothing while another session holds the lock. */
type Attempt<T> = { readonly result: T } | undefined;

/** Waits `ms`, or less once `stop` aborts. */
export async function PauseUnlessStopped(
  ms: number,
  stop: AbortSignal | undefined,
) {
  await delay(ms, undefined, { signal: stop }).catch(() => undefined);
}

/**
 * Runs a phase of a schema under the phase's named lock, which every process converging that
 * schema takes in turn. While another session holds it, the phase asks again every second, each
 * time on a pooled connection it gives back at once: the holder may work for minutes, and a phase
 * that kept a connection while it waited would take it from every query of the process. A holder
 * that dies releases the lock with its session.
 */
function WithPhaseLock<T>(
  phase: Phase,
  schemaKey: string,
  hooks: PhaseHooks,
  work: (session: ConvergenceSession) => Promise<T>,
): Promise<T> {
  return Serialized(`${phase}:${schemaKey}`, async () => {
    let waited = false;
    for (;;) {
      if (hooks.stop?.aborted) {
        throw new Error(
          `Stopped before the ${phase} phase of '${schemaKey}' began`,
        );
      }
      let attempt: Attempt<T>;
      try {
        attempt = await OnDedicatedSession(
          async (session): Promise<Attempt<T>> => {
            await hooks.opened?.(session);
            const name = await LockName(session, phase, schemaKey);
            return (await TakeLock(session, name, 0))
              ? { result: await Holding(session, name, work) }
              : undefined;
          },
        );
      } catch (err) {
        if (await hooks.again?.(err)) {
          continue;
        }
        throw err;
      }
      if (attempt) {
        return attempt.result;
      }
      if (!waited) {
        Logger.Info(
          `waiting for another process ${HOLDER_WORK[phase]} of schema '${schemaKey}'`,
        );
        waited = true;
      }
      await PauseUnlessStopped(LOCK_RETRY_MS, hooks.stop);
    }
  });
}

/**
 * Runs the tables phase of a schema under its tables lock: the process that goes second reads the
 * catalog the first left, and finds nothing left to do.
 */
export function WithTablesLock<T>(
  schemaKey: string,
  work: (session: ConvergenceSession) => Promise<T>,
): Promise<T> {
  return WithPhaseLock("tables", schemaKey, {}, work);
}

/**
 * Runs the index phase of a schema under its indexes lock. The holder builds the schema's indexes
 * from its own plan, which may lack some of this one's, so this phase runs once it is done and finds
 * left only what that plan did not build. A write that waits for the phase therefore waits for the
 * other build too.
 */
export function WithIndexesLock<T>(
  schemaKey: string,
  hooks: PhaseHooks,
  work: (session: ConvergenceSession) => Promise<T>,
): Promise<T> {
  return WithPhaseLock("indexes", schemaKey, hooks, work);
}

/** Stops whatever statement `session` is running, from a pooled connection. */
export async function Interrupt(session: ConvergenceSession): Promise<void> {
  await OnDedicatedSession((pooled) =>
    pooled.apply(GetDialect().ddl.killQuery(session.id)),
  );
}
