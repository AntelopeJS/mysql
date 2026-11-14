import type { Readable } from "node:stream";
import { PoolConnection as CallbackPoolConnection } from "mysql2";
import type { PoolConnection } from "mysql2/promise";

import {
  AcquireUncapped,
  Discard,
  GetDialect,
  ParseRow,
  type Row,
  ReleaseCapped,
} from "../../connection";
import {
  ClimbSortBuffer,
  OutOfSortMemory,
  type SortBufferLadder,
} from "../../sort-buffer";
import { CheckedBehind, CutBehind, WarnedFailure } from "../../warnings";
import { Bind, type Sql, sql } from "../../statement";
import { IsDocument } from "./guards";

const NOT_A_POOL_CONNECTION =
  "the driver handed out a pooled connection without the callback API's connection behind it, which a cursor's stream needs";

/** What a cursor reads from, and the one thing it must give back: the connection it holds. */
export interface RowSource {
  /**
   * Up to `count` rows, in order, waiting for the driver as long as the stream is short of them.
   * Fewer than `count` rows means the result is exhausted.
   */
  next(count: number): Promise<Row[]>;
  /** Gives the connection up. Total: a source already closed answers at once. */
  close(): Promise<void>;
}

/** The warnings a statement's first run tolerates. */
const NONE_TOLERATED = 0;

const STREAM_EVENTS = ["readable", "end", "close", "error"] as const;

/** Resolves on the next event that can change what {@link Take} sees: data, the end, or a failure. */
function Arrival(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    const settle = () => {
      for (const event of STREAM_EVENTS) {
        stream.off(event, settle);
      }
      resolve();
    };
    for (const event of STREAM_EVENTS) {
      stream.on(event, settle);
    }
  });
}

/**
 * One run of the cursor's statement: its stream, the failure it reported, whether it handed over a
 * row, and whether its end or failure was looked into.
 */
interface Attempt {
  readonly stream: Readable;
  failure?: Error;
  isRead: boolean;
  isSettled: boolean;
}

function Attempted(
  driver: CallbackPoolConnection,
  statement: Sql,
  batchSize: number,
): Attempt {
  const bound = Bind(statement);
  const stream = driver
    .execute(bound.sql, [...bound.args])
    .stream({ highWaterMark: batchSize });
  const attempt: Attempt = { stream, isRead: false, isSettled: false };
  stream.on("error", (err: Error) => {
    attempt.failure ??= err;
  });
  return attempt;
}

/**
 * One snapshot for every run of a checked statement, so a second run reads the rows the first
 * read and raises the warnings it raised, whatever another session writes meanwhile.
 */
const SNAPSHOT = [
  sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`,
  sql`START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY`,
];

const END_SNAPSHOT = sql`ROLLBACK`;

async function RunAll(
  connection: PoolConnection,
  statements: readonly Sql[],
): Promise<void> {
  for (const statement of statements) {
    await connection.query(Bind(statement).sql);
  }
}

/** Ends the snapshot a checked statement read in, answering whether that held. */
async function Ended(connection: PoolConnection, isChecked: boolean) {
  try {
    await RunAll(connection, isChecked ? [END_SNAPSHOT] : []);
    return true;
  } catch {
    return false;
  }
}

/** Puts back the session's sort buffer where a retry grew it, answering whether that held. */
async function Restored(ladder: SortBufferLadder | undefined) {
  try {
    await ladder?.restore();
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens the compiled statement on a connection taken from the pool for the cursor's whole life, as
 * an unbuffered result set read through the driver's stream with a high-water mark of one batch.
 *
 * The server sends only while the client reads: once a batch is waiting the stream pauses the
 * socket, and TCP flow control stops the server within the socket buffers, so a cursor holds about
 * one batch whatever the result's size. A statement that fails, a bad table or a syntax error among
 * them, fails the first `next`, not the open. A connection the server or the network ends fails the
 * `next` waiting on it: the driver reports that loss on the connection, not on the statement it
 * streams, so the stream would otherwise wait for rows that never come.
 *
 * On MariaDB a statement that calls a JSON function or an aggregate streams as the dialect's
 * `warnings.checked` writes it, so it fails before its first row where computing its rows raised a
 * warning, and no row read wrong is handed over. A statement that failed there for warnings no read
 * fails on, such as a sort past `max_sort_length`, runs once more, tolerating as many. A failure
 * after a row, or of a statement that streams as it is, is never run again for its warnings.
 * Every run of such a statement reads in one read-only transaction that took its snapshot before
 * the first, so the second reads the rows the first read and raises the warnings it raised; that
 * transaction holds the statement's metadata locks until the cursor closes.
 *
 * A statement that fails with `Out of sort memory` before its first row runs again on the same
 * connection up a {@link SortBufferLadder}: the server sorts before it sends a row, so no row is read
 * twice.
 *
 * Two costs the caller must know. The open statement holds a shared metadata lock on every table it
 * reads until the server has sent its last row, so a DDL statement on those tables waits that long:
 * until the cursor is read to its end or closed, unless the rest of the result fits in the socket
 * buffers between the server and the client. And the connection is out of the pool until the cursor
 * is read to its end or closed, which is what `maxOpenCursors` bounds.
 *
 * `close` after a `next` read the result's end and found the statement whole hands the connection
 * back to the pool, with the session's sort buffer put back. Any other `close` destroys the
 * connection instead of draining it or clearing what the statement left listed on it: the server
 * aborts the statement, and the pool opens a replacement on demand.
 */
export async function OpenRowStream(
  statement: Sql,
  batchSize: number,
): Promise<RowSource> {
  const connection = await AcquireUncapped();
  const pooled: unknown = connection.connection;
  if (!(pooled instanceof CallbackPoolConnection)) {
    await ReleaseCapped(connection);
    throw new Error(NOT_A_POOL_CONNECTION);
  }
  const driver = pooled;
  const dialect = GetDialect();
  const checked = (tolerated: number) =>
    dialect.capture.warnings?.checked(statement, tolerated) ?? statement;
  const first = checked(0);
  const isChecked = first !== statement;
  try {
    await RunAll(connection, isChecked ? SNAPSHOT : []);
  } catch (err) {
    connection.destroy();
    throw err;
  }
  let attempt = Attempted(driver, first, batchSize);
  let tolerated: number | undefined;
  let ladder: SortBufferLadder | undefined;
  let isLadderSpent = false;
  let isClosed = false;
  let isClean = false;
  const lost = (err: Error) => {
    attempt.failure ??= err;
    attempt.stream.destroy(err);
  };
  driver.on("error", lost);

  async function Settle(): Promise<void> {
    attempt.isSettled = true;
    if (!attempt.failure) {
      attempt.failure = await WarnedFailure(connection, dialect);
      isClean = !attempt.failure;
      return;
    }
    const behind =
      isChecked && !attempt.isRead
        ? await CheckedBehind(connection, dialect, attempt.failure)
        : await CutBehind(connection, dialect, attempt.failure);
    if (behind instanceof Error) {
      attempt.failure = behind;
    } else if (behind <= (tolerated ?? NONE_TOLERATED)) {
      return;
    } else if (tolerated === undefined) {
      tolerated = behind;
      attempt = Attempted(driver, checked(behind), batchSize);
    } else {
      attempt.failure = new Error(
        `MariaDB raised ${behind} warnings computing the cursor's rows on a second run where the first raised ${tolerated}, none of them one a read fails on; re-run the query`,
      );
    }
  }

  async function Take(count: number): Promise<Row[]> {
    const rows: Row[] = [];
    while (rows.length < count) {
      const { stream } = attempt;
      const row: unknown = stream.read();
      attempt.failure ??= stream.errored ?? undefined;
      if (IsDocument(row)) {
        attempt.isRead = true;
        rows.push(ParseRow(Object.entries(row)));
      } else if (
        !attempt.isRead &&
        !isLadderSpent &&
        OutOfSortMemory(attempt.failure)
      ) {
        ladder ??= await ClimbSortBuffer(connection);
        if (await ladder.grow()) {
          attempt = Attempted(
            driver,
            checked(tolerated ?? NONE_TOLERATED),
            batchSize,
          );
        } else {
          isLadderSpent = true;
        }
      } else if (
        (attempt.failure || stream.readableEnded) &&
        !attempt.isSettled
      ) {
        await Settle();
      } else if (attempt.failure) {
        throw attempt.failure;
      } else if (stream.readableEnded || stream.destroyed) {
        break;
      } else {
        await Arrival(stream);
      }
    }
    return rows;
  }

  return {
    next: Take,
    async close() {
      if (isClosed) {
        return;
      }
      isClosed = true;
      driver.off("error", lost);
      if (
        isClean &&
        !attempt.failure &&
        (await Ended(connection, isChecked)) &&
        (await Restored(ladder))
      ) {
        await ReleaseCapped(connection);
      } else {
        Discard(connection);
        attempt.stream.destroy();
      }
    },
  };
}
