import type { PoolConnection } from "mysql2/promise";

import { Bind, sql } from "../../statement";
import { AcquireConnection, GetDialect } from "../../connection";

/**
 * How many times a unit runs before its last failure is the answer, by why it failed. A deadlock
 * is found at once and lets the other transaction through, so it is cheap to run again, and
 * writers that lock rows in opposite orders keep meeting until a pause sets them apart. A lock
 * wait already waited the server's whole timeout. Any other failure `retries` accepts, a lost race
 * to insert one key, is settled by its first rerun.
 */
const ATTEMPTS = { deadlock: 12, lockWait: 3, accepted: 3 } as const;

/** The longest pause before a deadlocked unit runs again, in milliseconds. */
const MAX_PAUSE_MS = 400;

/** The first pause's bound, which doubles with each attempt. */
const FIRST_PAUSE_MS = 5;

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

/** How many attempts in all a failure allows the unit, or 0 when it is not run again. */
function Allowed(error: Error, retries: RetryPredicate): number {
  const { kind } = GetDialect().errors.classify(error);
  if (kind === "deadlock" || kind === "lockWait") {
    return ATTEMPTS[kind];
  }
  return retries(error) ? ATTEMPTS.accepted : 0;
}

/**
 * A random pause below a bound that doubles with each attempt. Writers that deadlocked each other
 * would meet again if they ran again at once; a random pause sets them apart.
 */
function Pause(attempt: number): Promise<void> {
  const bound = Math.min(MAX_PAUSE_MS, FIRST_PAUSE_MS * 2 ** attempt);
  return new Promise((resolve) => {
    setTimeout(resolve, Math.random() * bound);
  });
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
 * `retries` accepts, after a random pause, up to as many attempts in all as {@link ATTEMPTS} gives
 * the failure: every unit given here reads what it writes against inside the transaction, so
 * running it twice converges on the same rows.
 */
export async function InTransaction<T>(
  unit: TransactionUnit<T>,
  retries: RetryPredicate = NEVER,
  attempt = 1,
): Promise<T> {
  try {
    return await Attempt(unit);
  } catch (err) {
    if (err instanceof Error && attempt < Allowed(err, retries)) {
      await Pause(attempt);
      return InTransaction(unit, retries, attempt + 1);
    }
    throw err;
  }
}
