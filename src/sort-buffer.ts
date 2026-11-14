import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import { Bind, int, sql } from "./statement";

/** `ER_OUT_OF_SORTMEMORY`, which MySQL and MariaDB answer when one sorted row outgrows the sort buffer. */
const OUT_OF_SORT_MEMORY = 1038;

/** How many times larger each retry's sort buffer is than the one before. */
const GROWTH = 4;

const LIMITS = sql`SELECT @@session.sort_buffer_size AS buffer, @@max_allowed_packet AS packet`;

/** Whether `err` is the server's `Out of sort memory`, which a larger sort buffer can answer. */
export function OutOfSortMemory(err: unknown): err is Error {
  return (
    err instanceof Error && "errno" in err && err.errno === OUT_OF_SORT_MEMORY
  );
}

/**
 * The larger sort buffers a session tries in turn after a read ran out of its own, and how to put
 * its own back. MySQL sorts a JSON column's whole stored value with each row, a `GROUP BY` that
 * collects one included, and fails where one row outgrows the buffer: its 256 KiB default holds no
 * row of a document stored larger than that. Each buffer is {@link GROWTH} times the last, so a read
 * spends at most that many times the least buffer that holds its largest row, and the last is
 * `max_allowed_packet`, where the retries stop. A session sets the buffer without any privilege.
 */
export interface SortBufferLadder {
  /** Sets the next larger buffer and answers true, or answers false once the last was tried. */
  grow(): Promise<boolean>;
  /** Puts back the buffer the session had; a no-op where {@link grow} never set one. */
  restore(): Promise<void>;
}

async function SetSortBuffer(connection: PoolConnection, bytes: number) {
  await connection.query(
    Bind(sql`SET SESSION sort_buffer_size = ${int(bytes)}`).sql,
  );
}

/** Reads the session's buffer and the packet limit on `connection`, the first and last rungs. */
export async function ClimbSortBuffer(
  connection: PoolConnection,
): Promise<SortBufferLadder> {
  const [rows] = await connection.query<RowDataPacket[]>(Bind(LIMITS).sql);
  const buffered: unknown = rows[0]?.buffer;
  const packeted: unknown = rows[0]?.packet;
  const original = Number(buffered);
  const packet = Number(packeted);
  let current = original;
  return {
    async grow() {
      if (current >= packet) {
        return false;
      }
      current = Math.min(current * GROWTH, packet);
      await SetSortBuffer(connection, current);
      return true;
    },
    async restore() {
      if (current !== original) {
        await SetSortBuffer(connection, original);
      }
    },
  };
}

/**
 * Runs `read` on `connection` and, where it fails with `Out of sort memory`, runs it again up the
 * {@link SortBufferLadder}, then puts the session's buffer back. Every other read keeps the server's
 * buffer, and each attempt gets the session's whole statement timeout. A restore that fails leaves
 * the read's own outcome to the caller and destroys the connection, which must not go back to the
 * pool with the larger buffer.
 */
export async function ReadGrowingSortBuffer<T>(
  connection: PoolConnection,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (!OutOfSortMemory(err)) {
      throw err;
    }
    return await ReadUpLadder(connection, read, err);
  }
}

async function ReadUpLadder<T>(
  connection: PoolConnection,
  read: () => Promise<T>,
  first: Error,
): Promise<T> {
  const ladder = await ClimbSortBuffer(connection);
  try {
    let failure = first;
    while (await ladder.grow()) {
      try {
        return await read();
      } catch (err) {
        if (!OutOfSortMemory(err)) {
          throw err;
        }
        failure = err;
      }
    }
    throw failure;
  } finally {
    await ladder.restore().catch(() => connection.destroy());
  }
}
