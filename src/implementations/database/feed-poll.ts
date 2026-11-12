import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";

import type { Sql } from "../../statement";
import type { Row } from "../../connection";
import type { ChangeOperation, Dialect } from "../../dialect";
import { CHANGE_LOG } from "./registry";
import { UnsignedOf } from "./sequencer";
import { BOOL, JsonOf, type SqlType } from "./types";
import { EVENT_ALIAS, type FeedPlan } from "./feed-pipeline";
import { DecodeCell, type RowObject, type RowValue } from "./result";
import { IsDocument } from "./guards";

/** What a feed watches: the physical table its triggers log, and the stored instance it reads. */
export interface FeedTarget {
  readonly schemaId: string;
  readonly tableId: string;
  readonly table: string;
  readonly instance: typeof CROSS_INSTANCE | string;
}

/** One side of an event as the poll answered it: what it projects, and whether it matched. */
interface LoggedSide {
  readonly doc: RowValue;
  readonly matched: boolean;
}

/**
 * One log row a poll scanned, with the sides its images have. A `deep` event has neither: a value
 * it holds nests too deep for the document around it.
 */
export interface LoggedEvent {
  readonly seq: bigint;
  readonly op: ChangeOperation;
  readonly deep: boolean;
  readonly old?: LoggedSide;
  readonly new?: LoggedSide;
}

/**
 * What one poll read: the log's epoch and frontier, the high-water the reaper left for the feed's
 * table if it ever reaped it, and the rows scanned, in `seq` order.
 */
export interface PollAnswer {
  readonly epoch: string;
  readonly frontier: bigint;
  readonly highWater?: bigint;
  readonly scanned: readonly LoggedEvent[];
}

const OPERATIONS: readonly ChangeOperation[] = ["added", "modified", "removed"];

/** The one read a poll makes. */
export function PollStatement(
  dialect: Dialect,
  plan: FeedPlan,
  target: FeedTarget,
  after: bigint,
  limit: number,
): Sql {
  return dialect.capture.poll(CHANGE_LOG, {
    table: target.table,
    instance: target.instance === CROSS_INSTANCE ? undefined : target.instance,
    after,
    limit,
    alias: EVENT_ALIAS,
    old: plan.old,
    new: plan.new,
    nested: plan.nested,
  });
}

function OperationOf(row: Row): ChangeOperation {
  const op = row.get("op");
  const operation = OPERATIONS.find((known) => known === op);
  if (!operation) {
    throw new Error(
      `The change log holds a row whose operation is ${String(op)}`,
    );
  }
  return operation;
}

/** A side's `{doc, matched}`, with the instants the projection declares revived. */
function SideOf(
  row: Row,
  column: string,
  type: SqlType,
): LoggedSide | undefined {
  const cell = row.get(column);
  if (cell === null || cell === undefined) {
    return undefined;
  }
  const side: RowValue = DecodeCell(cell, JsonOf({ doc: type, matched: BOOL }));
  if (!IsDocument(side)) {
    throw new Error(`A change feed's ${column} is not a document`);
  }
  const document: RowObject = side;
  return { doc: document.doc ?? null, matched: document.matched === true };
}

function EventOf(row: Row, type: SqlType): LoggedEvent {
  return {
    seq: UnsignedOf(row, "seq"),
    op: OperationOf(row),
    deep: Number(row.get("deep")) === 1,
    old: SideOf(row, "old_side", type),
    new: SideOf(row, "new_side", type),
  };
}

/** Reads a poll's rows: one carries the frontier and no event when the feed's table has none. */
export function ReadPoll(rows: readonly Row[], type: SqlType): PollAnswer {
  const [first] = rows;
  if (!first) {
    throw new Error(
      "The change log's clock row is missing; the next schema registration creates it again",
    );
  }
  const reaped = first.get("high_water");
  return {
    epoch: String(first.get("epoch")),
    frontier: UnsignedOf(first, "frontier"),
    highWater:
      reaped === null || reaped === undefined
        ? undefined
        : UnsignedOf(first, "high_water"),
    scanned: rows
      .filter((row) => row.get("seq") !== null)
      .map((row) => EventOf(row, type)),
  };
}
