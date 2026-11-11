import type { Measure } from "@antelopejs/interface-database-catalog";
import type { PoolConnection } from "mysql2/promise";

import {
  AcquireConnection,
  GetDialect,
  Read,
  type Row,
} from "../../connection";
import { Bind, type Sql } from "../../statement";

const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;

let statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS;

/**
 * Overrides the per-measure statement timeout, for the suite that proves a slow measure answers
 * `timeout`; no configuration reaches it.
 */
export function SetMeasureTimeoutForTests(ms?: number): void {
  statementTimeoutMs = ms ?? DEFAULT_STATEMENT_TIMEOUT_MS;
}

/** One read-only transaction, its statements each answered as a measure that may fail alone. */
export interface MeasureSession {
  measure(statement: Sql): Promise<Measure<Row[]>>;
}

/**
 * A failed statement leaves a MySQL transaction usable, so a measure needs no savepoint: its
 * failure is answered, and the next measure runs in the same transaction.
 */
function SessionOver(connection: PoolConnection): MeasureSession {
  return {
    async measure(statement) {
      try {
        return { status: "ok", value: await Read(statement, connection) };
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        const failure = GetDialect().external.measures.failure(error);
        return failure.timeout
          ? { status: "timeout" }
          : { status: "error", code: failure.code };
      }
    },
  };
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs one call at a time in the process, so profiling never fans out over the client's pool. */
function Serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Runs `work` in a `READ ONLY` transaction whose reads stop after the statement timeout and wait
 * at most a second for a lock, and rolls it back: nothing it does can write, whatever the connected
 * account may, and nothing waits on the client's locks for long. The session's timeouts were
 * changed for the work, so its connection is closed rather than returned to the pool.
 */
export function WithMeasures<T>(
  work: (session: MeasureSession) => Promise<T>,
): Promise<T> {
  return Serialized(async () => {
    const measures = GetDialect().external.measures;
    const connection = await AcquireConnection();
    try {
      for (const statement of measures.open(statementTimeoutMs)) {
        await connection.query(Bind(statement).sql);
      }
      return await work(SessionOver(connection));
    } finally {
      await connection.query(Bind(measures.close).sql).catch(() => undefined);
      connection.destroy();
    }
  });
}

/** The first row of a measure, or the measure's failure. */
export function FirstRow<R>(
  measured: Measure<Row[]>,
  read: (row: Row) => R,
): Measure<R> {
  if (measured.status !== "ok") {
    return measured;
  }
  return { status: "ok", value: read(measured.value[0]) };
}

export function Mapped<T, R>(
  measured: Measure<T>,
  read: (value: T) => R,
): Measure<R> {
  return measured.status === "ok"
    ? { status: "ok", value: read(measured.value) }
    : measured;
}

export function ValueOf<T>(measured: Measure<T> | undefined): T | undefined {
  return measured?.status === "ok" ? measured.value : undefined;
}

/** A cell read as a number: the server answers counts and sums as text past 32 bits. */
export function NumberOf(row: Row | undefined, column: string): number | null {
  const cell = row?.get(column);
  return cell === null || cell === undefined ? null : Number(cell);
}

/** Runs `work` over `items` one after another, never two statements at once. */
export async function Sequentially<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) {
    results.push(await work(item));
  }
  return results;
}
