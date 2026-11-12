import type { Sql } from "../statement";
import type { SqlType } from "../implementations/database/types";

/** What happened to a row, spelled as the interface's `Changes<T>.changeType`. */
export type ChangeOperation = "added" | "modified" | "removed";

/** The change log's tables, and the two log columns a feed's compiled sides read, by name. */
export interface ChangeLogTables {
  /** One row per captured write, numbered by `seq` only once its transaction has committed. */
  readonly log: string;
  /** One row: the next `seq` to hand out, and the epoch the log was created in. */
  readonly clock: string;
  /** Per watched table, the highest `seq` the reaper has deleted. */
  readonly reaped: string;
  /** The log column holding a row's image before the write. */
  readonly oldImage: string;
  /** The log column holding a row's image after the write. */
  readonly newImage: string;
}

/** A stored column a trigger writes into a row's image, as the type it holds. */
export interface CapturedColumn {
  readonly name: string;
  readonly type: SqlType;
}

/** What one of a table's triggers runs for each row an operation writes. */
export interface TriggerBody {
  readonly operation: ChangeOperation;
  readonly body: Sql;
}

/** One feed's read of the log: the rows of one table numbered after `after`, up to the frontier. */
export interface PollRequest {
  readonly table: string;
  /** The stored instance the feed is scoped to; absent for a feed over every instance. */
  readonly instance?: string;
  /** The highest `seq` the feed has accounted for, in decimal. */
  readonly after: bigint;
  readonly limit: number;
  /** The alias the polled log row is read at, which `old` and `new` read its images through. */
  readonly alias: string;
  /** Each side: a statement answering one row of one JSON column, `{doc, matched}`. */
  readonly old: Sql;
  readonly new: Sql;
}

/**
 * Change capture: the log's objects, the triggers that fill it, the sequencer that numbers it, the
 * feed's read of it and the reaper's delete. The log's shape is the same on every engine; what is
 * spelled here is how an engine writes, locks and reads it.
 *
 * Every statement answers its columns under fixed aliases: `next_seq`, `epoch`, `frontier`,
 * `pending`, `id`, `tbl`, `high_water`, `through`, and for a poll `seq`, `op`, `old_side` and
 * `new_side` beside the frontier's.
 */
export interface CaptureSyntax {
  /**
   * Creates the log, the clock and the reaped table where absent, and seeds the clock once. A log
   * created now is named `logId`, and the clock renews its epoch whenever the log it numbers is not
   * the one it last saw, so a log created again ends every feed that read the one before.
   */
  bootstrap(tables: ChangeLogTables, logId: string): readonly Sql[];
  /**
   * The bodies of the three triggers that log a table's writes. An image is a JSON object of
   * `columns`, a JSON-backed column boxed so its SQL NULL stays apart from a JSON null and the image
   * nests no deeper than the column, and an update that leaves every column as it was logs nothing.
   */
  triggers(
    tables: ChangeLogTables,
    table: string,
    columns: readonly CapturedColumn[],
  ): readonly TriggerBody[];
  createTrigger(name: string, table: string, trigger: TriggerBody): Sql;
  dropTrigger(name: string): Sql;
  /**
   * What to tell the caller when the server refused to create a trigger for want of a privilege or
   * a server setting, naming the cause and every remedy; `undefined` for any other failure.
   */
  triggerRefusal(error: Error): string | undefined;
  /** Holds a table against every other session, so no write runs while its triggers change. */
  lockTable(table: string): Sql;
  readonly unlockTables: Sql;
  /**
   * Marks the session's updates as moving stored values without changing any document, so the
   * triggers log none of them, until `unmarkMoves` runs or the session ends.
   */
  readonly markMoves: Sql;
  readonly unmarkMoves: Sql;
  /**
   * The type an image logs a column as, from the type the catalog reports for it; `undefined` for a
   * type the module never gives a column it stores.
   */
  loggedType(columnType: string): SqlType | undefined;
  /** A boxed member of an image, unboxed to its JSON value: SQL NULL where the column held SQL NULL. */
  unbox(member: Sql): Sql;
  /**
   * Locks the clock row and answers `next_seq` and `epoch`. Without `wait`, answers no row while
   * another session holds it, which is a sequencer pass already running.
   */
  lockClock(tables: ChangeLogTables, wait: boolean): Sql;
  /**
   * Locks up to `limit` rows still without a `seq`, in the order they were logged, and answers
   * their `id`s. A row whose transaction is still open is skipped, so only committed rows are
   * numbered.
   */
  unsequenced(tables: ChangeLogTables, limit: number): Sql;
  /** Numbers the rows `ids`, in that order, from `first`, and stamps them with the time. */
  stamp(tables: ChangeLogTables, ids: readonly string[], first: bigint): Sql;
  /** Moves the clock past `count` numbers. */
  advance(tables: ChangeLogTables, count: number): Sql;
  /**
   * One row: `epoch`, the `frontier` (the highest `seq` handed out) and `pending`, whether a
   * committed row still waits for its number.
   */
  frontier(tables: ChangeLogTables): Sql;
  /** The tables, as `tbl`, with a row numbered after `after`. */
  changedTables(tables: ChangeLogTables, after: bigint): Sql;
  /**
   * The frontier's row with the table's reaped `high_water`, joined to the rows of `request`
   * numbered after `after` and at most the frontier, in `seq` order, up to the limit; one row with
   * no event when there is none. Everything is read in one statement, so the rows, the frontier
   * and the high-water agree.
   */
  poll(tables: ChangeLogTables, request: PollRequest): Sql;
  /**
   * As `through`, the highest `seq` among the oldest `limit` numbered rows stamped more than
   * `retentionMs` ago; SQL NULL when there is none.
   */
  reapThrough(tables: ChangeLogTables, retentionMs: number, limit: number): Sql;
  /** Raises each table's reaped high-water to its highest `seq` at or below `through`. */
  raiseReaped(tables: ChangeLogTables, through: bigint): Sql;
  /** Deletes every numbered row at or below `through`. */
  reap(tables: ChangeLogTables, through: bigint): Sql;
}
