import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import { Bind, int, sql } from "./statement";

/** `ER_OUT_OF_SORTMEMORY`, which MySQL and MariaDB answer when one sorted row outgrows the sort buffer. */
const OUT_OF_SORT_MEMORY = 1038;

/** How many times larger each retry's sort buffer is than the one before. */
const GROWTH = 4;

const LIMITS = sql`SELECT @@session.sort_buffer_size AS buffer, @@max_allowed_packet AS packet`;

function OutOfSortMemory(err: unknown): err is Error {
  return (
    err instanceof Error && "errno" in err && err.errno === OUT_OF_SORT_MEMORY
  );
}

/**
 * The sort buffers a retry tries after `buffer`, each {@link GROWTH} times the last and the final one
 * `packet`: a sorted row carries at most one stored document, which `max_allowed_packet` bounds.
 */
function Ladder(buffer: number, packet: number): number[] {
  const sizes: number[] = [];
  for (let size = buffer * GROWTH; size < packet; size *= GROWTH) {
    sizes.push(size);
  }
  return buffer < packet ? [...sizes, packet] : sizes;
}

async function SetSortBuffer(connection: PoolConnection, bytes: number) {
  await connection.query(
    Bind(sql`SET SESSION sort_buffer_size = ${int(bytes)}`).sql,
  );
}

/**
 * Runs `read` on `connection` and, where its sort fails with `Out of sort memory`, runs it again
 * under a sort buffer {@link GROWTH} times larger each time, up to `max_allowed_packet`, then puts
 * the session's buffer back. MySQL sorts a JSON column's whole value with each row, a `GROUP BY`
 * that collects one included, and fails where one row outgrows its 256 KiB default. Only a read that
 * failed spends more sort memory, at most {@link GROWTH} times what its largest row needs; every
 * other statement keeps the server's buffer. A session sets the buffer without any privilege.
 */
export async function GrowingSortBuffer<T>(
  connection: PoolConnection,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (!OutOfSortMemory(err)) {
      throw err;
    }
    return await Retried(connection, read, err);
  }
}

async function Retried<T>(
  connection: PoolConnection,
  read: () => Promise<T>,
  first: Error,
): Promise<T> {
  const [rows] = await connection.query<RowDataPacket[]>(Bind(LIMITS).sql);
  const buffered: unknown = rows[0]?.buffer;
  const packet: unknown = rows[0]?.packet;
  const buffer = Number(buffered);
  let failure = first;
  try {
    for (const size of Ladder(buffer, Number(packet))) {
      await SetSortBuffer(connection, size);
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
    await SetSortBuffer(connection, buffer);
  }
}
