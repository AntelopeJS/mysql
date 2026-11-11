import assert from "node:assert";
import type { QueryStage } from "@antelopejs/interface-database/common";

import { type Sql, sql } from "../../statement";
import type { Dialect } from "../../dialect";
import type { Compiled } from "./sql";
import type { SqlType } from "./types";
import { AsFloat, Numeric } from "./readings";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import { CurrentValue, type Relation, SetProjection } from "./relation";
import { AbsorbOrder, Prepare, type RelationFlag } from "./render";
import { IsString } from "./guards";
import { OptionsOf } from "./utils";

/**
 * An aggregate reads whichever rows the relation has already selected. `ordered` is deliberately
 * absent: an ordering cannot change an aggregate, so the terms clear.
 */
const AGGREGATE_BLOCKERS: readonly RelationFlag[] = [
  "projection",
  "limit",
  "offset",
  "distinct",
  "aggregated",
];

/**
 * Everything that blocks an aggregate, plus an existing ordering: `SELECT DISTINCT … ORDER BY` a
 * term outside the select list is refused, so wrapping moves the sort inside.
 */
const DISTINCT_BLOCKERS: readonly RelationFlag[] = [
  ...AGGREGATE_BLOCKERS,
  "ordered",
];

/**
 * An aggregate over an operand, optionally over its *distinct* values. A group's sub-stream spends
 * a pending `distinct` through the flag; `min` and `max` take it harmlessly, since a dedup cannot
 * move an extremum.
 */
export type Aggregation = (
  dialect: Dialect,
  operand: Compiled,
  distinct?: boolean,
) => Compiled;

/**
 * The field an aggregate reads, or nothing for the whole-value reading. A name that is present and
 * not a string is a malformed stage, and reading it as absent would answer a different question. A
 * group's sub-stream reads the same option off the same stages, so it reads it through here.
 */
export function NamedField(stage: QueryStage): string | undefined {
  const field: unknown = OptionsOf(stage)?.field;
  if (field === undefined) {
    return undefined;
  }
  assert(
    IsString(field),
    `The '${stage.stage}' stage was given a field that is not a name`,
  );
  return field;
}

/** What an aggregate reads: the named field through the relation's own source, else its value. */
function Operand(relation: Relation, stage: QueryStage): Compiled {
  const field = NamedField(stage);
  return field === undefined
    ? CurrentValue(relation)
    : relation.source.field(field);
}

const SUM = sql`SUM`;
const AVG = sql`AVG`;
const MIN = sql`MIN`;
const MAX = sql`MAX`;

/** The one spelling of an aggregate call, and the one owner of its `DISTINCT` prefix. */
function Applied(func: Sql, argument: Sql, distinct = false): Sql {
  const deduped = distinct ? sql`DISTINCT ${argument}` : argument;
  return sql`${func}(${deduped})`;
}

/** ReQL's sum of an empty stream is 0, where `SUM` over no row is NULL. */
export const Total: Aggregation = (dialect, operand, distinct) =>
  AsFloat(
    dialect,
    sql`COALESCE(${Applied(SUM, Numeric(dialect, operand).sql, distinct)}, 0)`,
  );

export const Mean: Aggregation = (dialect, operand, distinct) =>
  AsFloat(dialect, Applied(AVG, Numeric(dialect, operand).sql, distinct));

/** The kinds an extremum compares as themselves; any other operand is compared as a number. */
const ORDERED_KINDS: ReadonlySet<SqlType["kind"]> = new Set([
  "text",
  "float",
  "timestamp",
]);

/**
 * `min` and `max` over the kinds that order as themselves, and over a numeric reading of the rest,
 * which is the answer `arr_min`/`arr_max` give. The result keeps the operand's type, and only a
 * number is read as a double, once, after every row has been reduced to it.
 */
function Extremum(func: Sql): Aggregation {
  return (dialect, operand, distinct) => {
    const ordered = ORDERED_KINDS.has(operand.type.kind)
      ? operand
      : Numeric(dialect, operand);
    const applied = Applied(func, ordered.sql, distinct);
    return ordered.type.kind === "float"
      ? AsFloat(dialect, applied)
      : { sql: sql`(${applied})`, type: ordered.type };
  };
}

export const Minimum: Aggregation = Extremum(MIN);

export const Maximum: Aggregation = Extremum(MAX);

/**
 * Counts rows, or the *distinct* values of an operand, as the contract asserts `count("car")`
 * against `new Set(cars).size`. The engine's count is an integer the driver hands back as text, so
 * it is read as a double.
 */
export function Tally(dialect: Dialect, operand?: Compiled): Compiled {
  const counted = operand ? sql`COUNT(DISTINCT ${operand.sql})` : sql`COUNT(*)`;
  return AsFloat(dialect, counted);
}

/** Moves the relation into value mode over the one row an aggregate yields, clearing the order. */
function SetAggregate(relation: Relation, value: Compiled): Relation {
  const aggregate = SetProjection(relation, value);
  AbsorbOrder(aggregate);
  aggregate.single = true;
  aggregate.aggregated = true;
  return aggregate;
}

function AggregateStage(aggregate: Aggregation): PipelineStage {
  return (relation, stage, context) => {
    const prepared = Prepare(relation, AGGREGATE_BLOCKERS, context);
    return SetAggregate(
      prepared,
      aggregate(context.dialect, Operand(prepared, stage)),
    );
  };
}

/** The one aggregate that reads the *presence* of its field rather than the field. */
const CountStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, AGGREGATE_BLOCKERS, context);
  const field = NamedField(stage);
  const operand =
    field === undefined ? undefined : prepared.source.field(field);
  return SetAggregate(prepared, Tally(context.dialect, operand));
};

/**
 * Dedups the relation, on one named field or on whole rows. A named field also becomes the
 * projection; either way the relation stays a stream.
 */
const DistinctStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, DISTINCT_BLOCKERS, context);
  prepared.distinct = true;
  const field = NamedField(stage);
  if (field === undefined) {
    return prepared;
  }
  return SetProjection(prepared, prepared.source.field(field));
};

/**
 * The stages that reduce a stream to one value, and the one that dedups it. The reductions are
 * exported already applied, because a group's sub-stream reduces each group's rows with the same
 * five and must reduce them the same way.
 */
export const AGGREGATE_STAGES: PipelineStageMap = {
  sum: AggregateStage(Total),
  avg: AggregateStage(Mean),
  min: AggregateStage(Minimum),
  max: AggregateStage(Maximum),
  count: CountStage,
  distinct: DistinctStage,
};
