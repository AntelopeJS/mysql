import assert from "node:assert";
import { Query } from "@antelopejs/interface-database";
import type { QueryStage } from "@antelopejs/interface-database/common";

import { sql } from "../../statement";
import type { Compiled } from "./sql";
import { Cast, Widen } from "./coerce";
import type { SqlType } from "./types";
import type { DecodingContext } from "./context";
import { DecodeFunction, RecordedLambda } from "./value";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import { Predicate } from "./readings";
import { FIRST_OPERAND, RequireOperand, SECOND_OPERAND } from "./stage";
import {
  CurrentValue,
  ScanColumns,
  type OrderTerm,
  type Relation,
  SetProjection,
  ValueRelation,
} from "./relation";
import {
  Prepare,
  type RelationFlag,
  Render,
  SINGLE_ROW,
  WHERE_BLOCKERS,
} from "./render";
import { IsString } from "./guards";
import { ClassifyMember, StageOperand } from "./member";
import { OptionsOf } from "./utils";

/** An `ORDER BY` runs before the row bounds, so those and an aggregate are what block it. */
const ORDER_BLOCKERS: readonly RelationFlag[] = [
  "projection",
  "limit",
  "offset",
  "aggregated",
];

/**
 * A row bound composes with nothing that is already bounding rows, and reads no field.
 * `projection` is absent, which is what keeps `map(…).slice(0, 2)` a single `SELECT`.
 */
const BOUND_BLOCKERS: readonly RelationFlag[] = [
  "limit",
  "offset",
  "aggregated",
];

const DESCENDING = "desc";

/**
 * Reads a caller's row bound: the count truncated toward zero and held between zero and the largest
 * count the driver binds exactly. An infinite or unreadable count bounds nothing.
 *
 * A bound computed by the statement itself would need the rows numbered by a window function, since
 * the engine takes only a constant there; that reading is not implemented yet and is refused by name.
 */
function Bound(stage: QueryStage, index: number): number | undefined {
  const member = ClassifyMember(StageOperand(stage, index));
  if (member.kind === "absent") {
    throw new Error(
      `Stage '${stage.stage}' requires an operand at position ${index}`,
    );
  }
  if (member.kind !== "number") {
    throw new Error(
      `Stage '${stage.stage}' takes a constant number at position ${index}; a ${member.kind} bound is not implemented by @antelopejs/mysql yet`,
    );
  }
  if (!Number.isFinite(member.value)) {
    return undefined;
  }
  const truncated = Math.trunc(member.value);
  return Math.min(Math.max(truncated, 0), Number.MAX_SAFE_INTEGER);
}

/**
 * Binds the predicate to the relation's own source rather than to a materialized document, which
 * is what keeps `filter((doc) => doc.key("age").gt(25))` reading an indexed column.
 */
const FilterStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, WHERE_BLOCKERS, context);
  const body = DecodeFunction(RecordedLambda(stage, FIRST_OPERAND), context, [
    prepared.source,
  ]);
  const predicate = RequireOperand(body, stage, FIRST_OPERAND);
  prepared.where.push(sql`(${Predicate(context.dialect, predicate).sql})`);
  return prepared;
};

function SortName(stage: QueryStage): string {
  const name: unknown = OptionsOf(stage)?.index;
  assert(
    IsString(name),
    "The 'orderBy' stage is missing the index or field to sort on",
  );
  return name;
}

/**
 * Prepends the sort terms, so a later `orderBy` dominates an earlier one, as stable sorts compose.
 * A declared index sorts by its key parts, key columns included, so its index serves the order.
 * No null ordering is spelled: naming one turns an index scan into a sort.
 */
const OrderByStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, ORDER_BLOCKERS, context);
  const descending = OptionsOf(stage)?.direction === DESCENDING;
  const terms = ScanColumns(prepared, SortName(stage)).map(
    (column): OrderTerm => ({ sql: column.order, descending }),
  );
  prepared.orderBy.unshift(...terms);
  return prepared;
};

const SliceStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, BOUND_BLOCKERS, context);
  prepared.offset = Bound(stage, FIRST_OPERAND);
  if (stage.args[SECOND_OPERAND] !== undefined) {
    prepared.limit = Bound(stage, SECOND_OPERAND);
  }
  return prepared;
};

const NthStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, BOUND_BLOCKERS, context);
  prepared.offset = Bound(stage, FIRST_OPERAND);
  prepared.limit = SINGLE_ROW;
  prepared.single = true;
  return prepared;
};

interface UnionSide {
  relation: Relation;
  value: Compiled;
}

function Sided(relation: Relation): UnionSide {
  return { relation, value: CurrentValue(relation) };
}

/** Renders one side of a union as a single-column `SELECT` of the type both sides meet at. */
function Materialize(side: UnionSide, type: SqlType) {
  const value = Cast(side.relation.dialect, side.value, type);
  return Render(SetProjection(side.relation, value));
}

/** Compiles the query the union concatenates, from its own `schema`/`instance`/`table` root. */
function Concatenated(stage: QueryStage, context: DecodingContext): Relation {
  const other = StageOperand(stage, FIRST_OPERAND);
  assert(
    other instanceof Query,
    "The 'union' stage takes another query to concatenate",
  );
  return context.relation(other.build());
}

/**
 * Concatenates two streams, keeping every row of both, as an ordinary value-mode relation.
 * The type is the {@link Widen} of the two sides, since each row carries only its own side's keys.
 */
const UnionStage: PipelineStage = (relation, stage, context) => {
  const left = Sided(relation);
  const right = Sided(Concatenated(stage, context));
  const type = Widen(left.value.type, right.value.type);
  return ValueRelation(
    context.dialect,
    sql`((${Materialize(left, type)}) UNION ALL (${Materialize(right, type)}))`,
    context.nextAlias(),
    type,
  );
};

/** The stages that select and order rows without reshaping what the relation yields. */
export const ROW_STAGES: PipelineStageMap = {
  filter: FilterStage,
  orderBy: OrderByStage,
  slice: SliceStage,
  nth: NthStage,
  union: UnionStage,
};
