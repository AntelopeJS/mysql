import type { Readable } from "node:stream";
import { PoolConnection as CallbackPoolConnection } from "mysql2";

import {
  AcquireUncapped,
  ParseRow,
  type Row,
  ReleaseCapped,
} from "../../connection";
import { Bind, type Sql } from "../../statement";
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
 * Opens the compiled statement on a connection taken from the pool for the cursor's whole life, as
 * an unbuffered result set read through the driver's stream with a high-water mark of one batch.
 *
 * The server sends only while the client reads: once a batch is waiting the stream pauses the
 * socket, and TCP flow control stops the server within the socket buffers, so a cursor holds about
 * one batch whatever the result's size. A statement that fails, a bad table or a syntax error among
 * them, fails the first `next`, not the open.
 *
 * Two costs the caller must know. The open statement holds a shared metadata lock on every table it
 * reads until it is read to its end or the connection is closed, so a DDL statement on those tables
 * waits that long. And the connection is out of the pool for the same time, which is what
 * `maxOpenCursors` bounds.
 *
 * `close` after the last row hands the connection back to the pool. `close` before it destroys the
 * connection instead of draining it: the server aborts the statement, and the pool opens a
 * replacement on demand.
 */
export async function OpenRowStream(
  statement: Sql,
  batchSize: number,
): Promise<RowSource> {
  const connection = await AcquireUncapped();
  const driver: unknown = connection.connection;
  if (!(driver instanceof CallbackPoolConnection)) {
    await ReleaseCapped(connection);
    throw new Error(NOT_A_POOL_CONNECTION);
  }
  const bound = Bind(statement);
  const stream = driver
    .execute(bound.sql, [...bound.args])
    .stream({ highWaterMark: batchSize });
  let failure: Error | undefined;
  let isClosed = false;
  stream.on("error", (err: Error) => {
    failure = err;
  });

  async function Take(count: number): Promise<Row[]> {
    const rows: Row[] = [];
    while (rows.length < count) {
      const row: unknown = stream.read();
      if (IsDocument(row)) {
        rows.push(ParseRow(Object.entries(row)));
      } else if (failure) {
        throw failure;
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
      if (stream.readableEnded && !failure) {
        await ReleaseCapped(connection);
      } else {
        connection.destroy();
        stream.destroy();
      }
    },
  };
}
