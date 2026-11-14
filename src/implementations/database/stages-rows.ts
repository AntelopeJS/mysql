import assert from "node:assert";
import { Query } from "@antelopejs/interface-database";
import type { QueryStage } from "@antelopejs/interface-database/common";

import type { Dialect } from "../../dialect";
import { type Sql, int, sql } from "../../statement";
import type { Compiled } from "./sql";
import { Cast, Widen } from "./coerce";
import type { SqlType } from "./types";
import type { DecodingContext } from "./context";
import { DecodeFunction, DecodeValue, RecordedLambda } from "./value";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import { Holds, Numeric } from "./readings";
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
  Numbered,
  type RelationFlag,
  Render,
  SINGLE_ROW,
  WHERE_BLOCKERS,
} from "./render";
import { ConcatenatedInPlace, InPlaceFor, Prepare, Walked } from "./wrap";
import { IsString } from "./guards";
import { ClassifyMember, StageOperand } from "./member";
import { OptionsOf } from "./utils";
import { ComparesIdWithOneValue } from "./join-key";

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

/** A row count the caller wrote as a number, as {@link Bound} reads it: none where it is infinite. */
export function ConstantCount(value: number): number | undefined {
  return Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), 0), Number.MAX_SAFE_INTEGER)
    : undefined;
}

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
    return { kind: "constant", count: ConstantCount(member.value) };
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
 * Bounds the rows: a known count as a bound `LIMIT` and `OFFSET`, and a count the statement
 * computes as a range of the rows' numbers, in their order, since the engine takes only a constant
 * there. Rows that read the outer row are numbered by a walk of their aggregate where the engine
 * reads no outer row inside the derived table {@link Numbered} numbers them in; a bound that reads
 * it alone does not count, since the range is tested outside the rows it numbers.
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
  const inPlace = InPlaceFor(context, readsOuterRow);
  const numbered = inPlace
    ? Walked(Prepare(relation, BOUND_BLOCKERS, context), inPlace, context)
    : Numbered(Prepare(relation, NUMBERING_BLOCKERS, context), context);
  numbered.relation.orderBy = [{ sql: numbered.rowNumber, descending: false }];
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
  const lambda = RecordedLambda(stage, FIRST_OPERAND);
  prepared.idBound ||=
    prepared.table !== undefined &&
    !prepared.crossInstance &&
    ComparesIdWithOneValue(lambda);
  prepared.where.push(
    context.fragment(() => {
      const body = DecodeFunction(lambda, context, [prepared.source]);
      const predicate = RequireOperand(body, stage, FIRST_OPERAND);
      return sql`(${Holds(context.dialect, predicate)})`;
    }),
  );
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
 * Once the subquery compiling now has read its outer row, an engine that reads no outer column
 * inside a derived table concatenates them in place.
 */
const UnionStage: PipelineStage = (relation, stage, context) => {
  const left = Sided(relation);
  const right = Sided(Concatenated(stage, context));
  const type = Widen(left.value.type, right.value.type);
  const inPlace = InPlaceFor(context, context.readsOuterRow);
  if (inPlace) {
    return ConcatenatedInPlace(
      [left.relation, right.relation],
      type,
      inPlace,
      context,
    );
  }
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
