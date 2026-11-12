import { sql } from "../../statement";
import type { Row } from "../../connection";
import type { Dialect } from "../../dialect";
import { CHANGE_LOG } from "./registry";
import type { ConvergenceSession } from "./locks";
import { IsNumber, IsString } from "./guards";

/** The most rows one pass numbers, which bounds the locks it holds and the ids it binds. */
const PASS_ROWS = 10_000;

/**
 * What a pass does when another session's pass holds the clock: wait for it, which is what a feed
 * opening needs, or leave the log to it, which is what a timer needs.
 */
export type ClockWait = "wait" | "skip";

/** Where the log stands: its epoch, the highest `seq` handed out, and whether a row awaits one. */
export interface Frontier {
  readonly epoch: string;
  readonly frontier: bigint;
  readonly pending: boolean;
}

const READ_COMMITTED = sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`;
const BEGIN = sql`START TRANSACTION`;
const COMMIT = sql`COMMIT`;
const ROLLBACK = sql`ROLLBACK`;

/** An unsigned integer the driver hands over as text. */
export function UnsignedOf(row: Row | undefined, column: string): bigint {
  const cell = row?.get(column);
  if (!IsString(cell) && !IsNumber(cell)) {
    throw new Error(
      `The change log answered no number in '${column}', which the statement always selects`,
    );
  }
  return BigInt(cell);
}

function TextOf(row: Row | undefined, column: string): string {
  const cell = row?.get(column);
  if (!IsString(cell)) {
    throw new Error(
      `The change log answered no text in '${column}', which the statement always selects`,
    );
  }
  return cell;
}

/**
 * Runs `work` in one READ COMMITTED transaction on `session`, rolled back if it throws. A rollback
 * that fails too leaves the first failure as the answer: the session that broke ends with its
 * connection, which rolls the transaction back anyway.
 */
export async function InSessionTransaction<T>(
  session: ConvergenceSession,
  work: () => Promise<T>,
): Promise<T> {
  await session.apply(READ_COMMITTED);
  await session.apply(BEGIN);
  try {
    const result = await work();
    await session.apply(COMMIT);
    return result;
  } catch (err) {
    await session.apply(ROLLBACK).catch(() => 0);
    throw err;
  }
}

async function Numbered(
  session: ConvergenceSession,
  { capture }: Dialect,
  wait: ClockWait,
): Promise<number | undefined> {
  const [clock] = await session.read(
    capture.lockClock(CHANGE_LOG, wait === "wait"),
  );
  if (!clock) {
    return undefined;
  }
  const rows = await session.read(capture.unsequenced(CHANGE_LOG, PASS_ROWS));
  const ids = rows.map((row) => UnsignedOf(row, "id").toString());
  if (ids.length > 0) {
    const first = UnsignedOf(clock, "next_seq");
    await session.write(capture.stamp(CHANGE_LOG, ids, first));
    await session.write(capture.advance(CHANGE_LOG, ids.length));
  }
  return ids.length;
}

/**
 * One sequencer pass: lock the clock row, read the rows still without a number that had committed
 * when the read began, number them from the clock in the order they were logged, and move the clock
 * past them, in one transaction.
 *
 * A row of a transaction still open when the read began is left to a later pass, which numbers it
 * once it has committed, so a `seq` is only ever given to a committed row, and never below one
 * already given. A row logged after another row's transaction committed gets the larger `seq`: the
 * read that finds it began after that transaction committed, so it finds that row too, earlier in
 * log order, unless a pass numbered it before. Two writes of one row are such a pair, since the
 * second waits on the first's row lock. Two transactions that both committed before the read are
 * numbered in the order their rows were logged, not the order they committed, which no statement
 * can see. Answers how many rows it numbered, or `undefined` when another session's pass held the
 * clock and `wait` is `skip`.
 */
export function SequenceOnce(
  session: ConvergenceSession,
  dialect: Dialect,
  wait: ClockWait,
): Promise<number | undefined> {
  return InSessionTransaction(session, () => Numbered(session, dialect, wait));
}

/** Runs passes until one numbers less than a full pass, or finds another session sequencing. */
export async function Sequence(
  session: ConvergenceSession,
  dialect: Dialect,
  wait: ClockWait,
): Promise<void> {
  for (;;) {
    const numbered = await SequenceOnce(session, dialect, wait);
    if (numbered === undefined || numbered < PASS_ROWS) {
      return;
    }
  }
}

function Parsed(row: Row | undefined): Frontier {
  if (!row) {
    throw new Error(
      "The change log's clock row is missing; the next schema registration creates it again",
    );
  }
  return {
    epoch: TextOf(row, "epoch"),
    frontier: UnsignedOf(row, "frontier"),
    pending: UnsignedOf(row, "pending") !== 0n,
  };
}

/** Reads where the log stands, through `session`. */
export async function ReadFrontier(
  session: ConvergenceSession,
  dialect: Dialect,
): Promise<Frontier> {
  const [row] = await session.read(dialect.capture.frontier(CHANGE_LOG));
  return Parsed(row);
}
