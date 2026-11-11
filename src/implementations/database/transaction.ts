import type { PoolConnection } from "mysql2/promise";

import { Bind, sql } from "../../statement";
import { AcquireConnection, GetDialect } from "../../connection";

/** How many times a unit runs before its last failure is the answer. */
const ATTEMPTS = 3;

/**
 * Applies to the next transaction only, so the session's own level is untouched. READ COMMITTED
 * takes no gap locks, which at REPEATABLE READ make two writers of different missing keys wait on
 * each other.
 */
const READ_COMMITTED = Bind(
  sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`,
).sql;

export type TransactionUnit<T> = (connection: PoolConnection) => Promise<T>;

/** Decides whether a failed attempt is run again, beyond the deadlocks and lock waits always are. */
export type RetryPredicate = (error: Error) => boolean;

function IsRetried(error: Error, retries: RetryPredicate): boolean {
  return GetDialect().errors.classify(error).kind === "retry" || retries(error);
}

/**
 * Ends a failed attempt. A rollback that fails leaves the connection in a state nothing can trust,
 * so it is destroyed rather than returned to the pool.
 */
async function Abandon(connection: PoolConnection): Promise<void> {
  try {
    await connection.rollback();
    connection.release();
  } catch {
    connection.destroy();
  }
}

async function Attempt<T>(unit: TransactionUnit<T>): Promise<T> {
  const connection = await AcquireConnection();
  try {
    await connection.query(READ_COMMITTED);
    await connection.beginTransaction();
    const result = await unit(connection);
    await connection.commit();
    connection.release();
    return result;
  } catch (err) {
    await Abandon(connection);
    throw err;
  }
}

const NEVER: RetryPredicate = () => false;

/**
 * Runs a write unit in one transaction at READ COMMITTED on a connection of its own.
 *
 * A deadlock or a lock wait timeout rolls the unit back and runs it again, as does any failure
 * `retries` accepts, at most {@link ATTEMPTS} times in all: every unit given here reads what it
 * writes against inside the transaction, so running it twice converges on the same rows.
 */
export async function InTransaction<T>(
  unit: TransactionUnit<T>,
  retries: RetryPredicate = NEVER,
  attempt = 1,
): Promise<T> {
  try {
    return await Attempt(unit);
  } catch (err) {
    if (attempt < ATTEMPTS && err instanceof Error && IsRetried(err, retries)) {
      return InTransaction(unit, retries, attempt + 1);
    }
    throw err;
  }
}
