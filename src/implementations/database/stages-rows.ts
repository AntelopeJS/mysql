import assert from "node:assert";
import { Query } from "@antelopejs/interface-database";
import type { QueryStage } from "@antelopejs/interface-database/common";

import type { Dialect } from "../../dialect";
import { type Sql, int, sql } from "../../statement";
import type { Compiled } from "./sql";
import { Cast, Widen } from "./coerce";
import { ArrayOf, OPAQUE, type SqlType } from "./types";
import type { InPlaceSyntax } from "../../dialect/sql-types";
import type { DecodingContext } from "./context";
import { DecodeFunction, DecodeValue, RecordedLambda } from "./value";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import { AsJson, Numeric, Predicate } from "./readings";
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
  HasFlag,
  NestedInOrder,
  Numbered,
  type NumberedRows,
  OrderTerms,
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

/**
 * A computed bound is numbered against rows that a dedup has not yet merged, so a pending
 * `DISTINCT` is wrapped first as well.
 */
const NUMBERING_BLOCKERS: readonly RelationFlag[] = [
  ...BOUND_BLOCKERS,
  "distinct",
];

const DESCENDING = "desc";

/**
 * A row count as a stage reads it: one known when the statement is compiled, absent where it
 * bounds nothing, or one the statement computes, SQL NULL where it bounds nothing.
 */
type RowBound =
  | { readonly kind: "constant"; readonly count: number | undefined }
  | { readonly kind: "computed"; readonly count: Sql };

const UNBOUNDED: RowBound = { kind: "constant", count: undefined };

/**
 * Reads a caller's row bound: the count truncated toward zero and held between zero and the largest
 * count the driver binds exactly, by the compiler for a constant and by the statement for anything
 * else. An infinite or unreadable count bounds nothing.
 */
function Bound(
  stage: QueryStage,
  index: number,
  context: DecodingContext,
): RowBound {
  const member = ClassifyMember(StageOperand(stage, index));
  if (member.kind === "number") {
    const count = Number.isFinite(member.value)
      ? Math.min(Math.max(Math.trunc(member.value), 0), Number.MAX_SAFE_INTEGER)
      : undefined;
    return { kind: "constant", count };
  }
  const value = RequireOperand(DecodeValue(member, context), stage, index);
  const dialect = context.dialect;
  const truncated = dialect.sql.scalar.truncate(Numeric(dialect, value).sql);
  return {
    kind: "computed",
    count: sql`LEAST(GREATEST(${truncated}, 0), ${int(Number.MAX_SAFE_INTEGER)})`,
  };
}

/** A bound as the statement reads it, SQL NULL where it bounds nothing. */
function CountOf(dialect: Dialect, bound: RowBound): Sql {
  if (bound.kind === "computed") {
    return bound.count;
  }
  return bound.count === undefined
    ? sql`NULL`
    : dialect.sql.scalar.bind.float(bound.count);
}

/** The numbered rows after `offset` and within `count` of them. */
function RowRange(
  dialect: Dialect,
  rowNumber: Sql,
  offset: RowBound,
  count: RowBound,
): Sql {
  const skipped = sql`COALESCE(${CountOf(dialect, offset)}, 0)`;
  const taken = CountOf(dialect, count);
  return sql`(${rowNumber} > ${skipped} AND (${taken} IS NULL OR ${rowNumber} <= ${skipped} + ${taken}))`;
}

/**
 * Numbers the rows through a walk of their aggregate in place, deduplicated and ordered as the
 * relation asks, where the engine reads no outer row inside the derived table {@link Numbered}
 * numbers them in. The walk reads it, so a nested query bounded by a count it computes reads its
 * outer row as well. The rows come back as the values they yield, in value mode.
 */
function NumberedInPlace(
  relation: Relation,
  inPlace: InPlaceSyntax,
  context: DecodingContext,
): NumberedRows {
  const dialect = context.dialect;
  const value = CurrentValue(relation);
  const rows = { distinct: relation.distinct, order: OrderTerms(relation) };
  relation.orderBy = [];
  relation.distinct = false;
  const collected = SetProjection(relation, {
    sql: inPlace.collect(AsJson(dialect, value).sql, rows),
    type: ArrayOf(value.type),
  });
  const alias = context.nextAlias();
  const walk = dialect.sql.json.walk(
    "elements",
    sql`(${Render(collected)})`,
    alias,
  );
  const numbered = SetProjection(
    ValueRelation(dialect, walk.from, alias, value.type),
    Cast(dialect, { sql: walk.value, type: OPAQUE }, value.type),
  );
  numbered.orderBy = [{ sql: walk.ordinal, descending: false }];
  return { relation: numbered, rowNumber: walk.ordinal };
}

/**
 * The relation a computed bound numbers. An ordered relation that a constant bound already cut is
 * wrapped with its order kept, so the rows are numbered in that order. A dedup and an aggregate
 * take no order after them, so neither reaches here ordered.
 */
function NumberingSource(
  relation: Relation,
  context: DecodingContext,
): Relation {
  const keepsOrder =
    relation.orderBy.length > 0 && HasFlag(relation, NUMBERING_BLOCKERS);
  return keepsOrder
    ? NestedInOrder(relation, context)
    : Prepare(relation, NUMBERING_BLOCKERS, context);
}

/**
 * Bounds the rows: a known count as a bound `LIMIT` and `OFFSET`, and a count the statement
 * computes as a range of the rows' numbers, since the engine takes only a constant there. Rows
 * that read the outer row are numbered in place where the engine needs it; a bound that reads it
 * alone does not count, since the range is tested outside the rows it numbers.
 */
function Bounded(
  relation: Relation,
  offset: RowBound,
  count: RowBound,
  readsOuterRow: boolean,
  context: DecodingContext,
): Relation {
  if (offset.kind === "constant" && count.kind === "constant") {
    const prepared = Prepare(relation, BOUND_BLOCKERS, context);
    prepared.offset = offset.count;
    prepared.limit = count.count;
    return prepared;
  }
  const inPlace = readsOuterRow ? context.dialect.sql.json.inPlace : undefined;
  const numbered = inPlace
    ? NumberedInPlace(
        Prepare(relation, BOUND_BLOCKERS, context),
        inPlace,
        context,
      )
    : Numbered(NumberingSource(relation, context), context);
  numbered.relation.where.push(
    RowRange(context.dialect, numbered.rowNumber, offset, count),
  );
  return numbered.relation;
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
 * A declared index sorts by its key parts, key columns included, so its index serves the order;
 * an external relation's column sorts by its native column or columns, in the column's own order.
 * No null ordering is spelled: naming one turns an index scan into a sort.
 */
const OrderByStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, ORDER_BLOCKERS, context);
  const descending = OptionsOf(stage)?.direction === DESCENDING;
  const terms = ScanColumns(prepared, SortName(stage)).flatMap((column) =>
    (column.value.native?.order ?? column.order).map((sql): OrderTerm => ({
      sql,
      descending,
    })),
  );
  prepared.orderBy.unshift(...terms);
  return prepared;
};

const SliceStage: PipelineStage = (relation, stage, context) => {
  const readsOuterRow = context.readsOuterRow;
  const offset = Bound(stage, FIRST_OPERAND, context);
  const count =
    stage.args[SECOND_OPERAND] === undefined
      ? UNBOUNDED
      : Bound(stage, SECOND_OPERAND, context);
  return Bounded(relation, offset, count, readsOuterRow, context);
};

const NthStage: PipelineStage = (relation, stage, context) => {
  const readsOuterRow = context.readsOuterRow;
  const offset = Bound(stage, FIRST_OPERAND, context);
  const one: RowBound = { kind: "constant", count: SINGLE_ROW };
  const bounded = Bounded(relation, offset, one, readsOuterRow, context);
  bounded.single = true;
  return bounded;
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
