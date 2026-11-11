import type { QueryStage } from "@antelopejs/interface-database/common";

import type { Dialect } from "../../dialect";
import type { Walk } from "../../dialect/sql-types";
import { type Sql, join, sql } from "../../statement";
import { Cast } from "./coerce";
import type { Compiled } from "./sql";
import { Collected } from "./json";
import { GuardJson } from "./json-guard";
import { DecodeFunction, RecordedLambda } from "./value";
import type { DecodingContext } from "./context";
import { ArrayOf, BOOL, FLOAT, OPAQUE, type SqlType } from "./types";
import { AsFloat, AsJson, Numeric, ORDERED_KINDS, Predicate } from "./readings";
import {
  BuildStages,
  FIRST_OPERAND,
  Lift,
  LiftRaw,
  RequireOperand,
  SECOND_OPERAND,
  type StageHandler,
  type StageMap,
} from "./stage";

type Measure = (dialect: Dialect, length: Sql) => Compiled;

type ElementReading = (elem: SqlType) => SqlType;

interface Reducer {
  reduce: (target: Sql) => Sql;
  reading: ElementReading;
}

/** Where the array begins: a bound below it counts from the end, and cannot reach past it. */
const ARRAY_ORIGIN = sql`0`;

function ElementType(type: SqlType): SqlType {
  return type.kind === "array" ? type.elem : OPAQUE;
}

/** An operand read as JSON, and the rows over its elements, named by a fresh alias. */
function Elements(value: Compiled, context: DecodingContext) {
  const json = AsJson(context.dialect, value);
  const walk = context.dialect.sql.json.walk(
    "elements",
    json.sql,
    context.nextAlias(),
  );
  return { json, walk };
}

function Element(dialect: Dialect, walk: Walk, type: SqlType): Compiled {
  return Cast(dialect, { sql: walk.value, type: OPAQUE }, type);
}

const MEASURES = {
  arr_count: (dialect, length) => AsFloat(dialect, length),
  arr_empty: (_dialect, length) => ({
    sql: sql`(${length} = 0)`,
    type: BOOL,
  }),
} satisfies Record<string, Measure>;

function MeasureStage(measure: Measure): StageHandler {
  return LiftRaw((value, _stage, context) => {
    const dialect = context.dialect;
    const json = AsJson(dialect, value);
    const measured = measure(dialect, dialect.sql.json.length(json.sql));
    return {
      sql: GuardJson(dialect, json, "array", measured.sql),
      type: measured.type,
    };
  });
}

const IndexStage = Lift((value, args, stage, context) => {
  const dialect = context.dialect;
  const json = AsJson(dialect, value);
  const key = RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND);
  const item: Compiled = {
    sql: dialect.sql.json.at(json.sql, Numeric(dialect, key).sql),
    type: OPAQUE,
  };
  const element = Cast(dialect, item, ElementType(value.type));
  return {
    sql: GuardJson(dialect, json, "array", element.sql),
    type: element.type,
  };
});

const IncludesStage = Lift((value, args, stage, context) => {
  const dialect = context.dialect;
  const other = AsJson(
    dialect,
    RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND),
  );
  return {
    sql: dialect.sql.json.includes(AsJson(dialect, value).sql, other.sql),
    type: BOOL,
  };
});

/**
 * One slice bound as an ordinal, counted back from the array's own length when it is negative.
 * Truncation is what makes a fractional bound agree with `Array.prototype.slice`.
 */
function FromEnd(dialect: Dialect, json: Sql, bound: Sql): Sql {
  const truncated = dialect.sql.scalar.truncate(bound);
  const counted = sql`GREATEST(${dialect.sql.json.length(json)} + ${truncated}, ${ARRAY_ORIGIN})`;
  return sql`(CASE WHEN ${truncated} < ${ARRAY_ORIGIN} THEN ${counted} ELSE ${truncated} END)`;
}

function Bounds(
  dialect: Dialect,
  json: Sql,
  ordinal: Sql,
  start: Compiled,
  end: Compiled | undefined,
): Sql {
  const low = FromEnd(dialect, json, Numeric(dialect, start).sql);
  const bounds = [sql`${ordinal} > ${low}`];
  if (end) {
    const high = FromEnd(dialect, json, Numeric(dialect, end).sql);
    bounds.push(sql`${ordinal} <= ${high}`);
  }
  return sql`(${join(bounds, sql` AND `)})`;
}

const SliceStage = Lift((value, args, stage, context) => {
  const dialect = context.dialect;
  const { json, walk } = Elements(value, context);
  const start = RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND);
  const bounds = Bounds(
    dialect,
    json.sql,
    walk.ordinal,
    start,
    args[SECOND_OPERAND],
  );
  const collected = Collected(dialect, walk.ordinal, walk.value);
  return {
    sql: GuardJson(dialect, json, "array", walk.aggregate(collected, bounds)),
    type: ArrayOf(ElementType(value.type)),
  };
});

/** The body of a recorded lambda, compiled with its parameter bound to one element of the walk. */
function ElementBody(
  value: Compiled,
  walk: Walk,
  stage: QueryStage,
  context: DecodingContext,
): Compiled {
  const element = Element(context.dialect, walk, ElementType(value.type));
  const body = DecodeFunction(RecordedLambda(stage, FIRST_OPERAND), context, [
    element,
  ]);
  return RequireOperand(body, stage, FIRST_OPERAND);
}

const MapStage = LiftRaw((value, stage, context) => {
  const dialect = context.dialect;
  const { json, walk } = Elements(value, context);
  const body = ElementBody(value, walk, stage, context);
  const collected = Collected(dialect, walk.ordinal, AsJson(dialect, body).sql);
  return {
    sql: GuardJson(dialect, json, "array", walk.aggregate(collected)),
    type: ArrayOf(body.type),
  };
});

const FilterStage = LiftRaw((value, stage, context) => {
  const dialect = context.dialect;
  const { json, walk } = Elements(value, context);
  const kept = Predicate(dialect, ElementBody(value, walk, stage, context)).sql;
  const collected = Collected(dialect, walk.ordinal, walk.value);
  return {
    sql: GuardJson(dialect, json, "array", walk.aggregate(collected, kept)),
    type: ArrayOf(ElementType(value.type)),
  };
});

const AS_NUMBER: ElementReading = () => FLOAT;
const AS_COMPARABLE: ElementReading = (elem) =>
  ORDERED_KINDS[elem.kind] ?? FLOAT;

const REDUCERS = {
  arr_sum: {
    reduce: (target) => sql`COALESCE(SUM(${target}), 0)`,
    reading: AS_NUMBER,
  },
  arr_avg: { reduce: (target) => sql`AVG(${target})`, reading: AS_NUMBER },
  arr_min: { reduce: (target) => sql`MIN(${target})`, reading: AS_COMPARABLE },
  arr_max: { reduce: (target) => sql`MAX(${target})`, reading: AS_COMPARABLE },
} satisfies Record<string, Reducer>;

function ReducerStage(reducer: Reducer): StageHandler {
  return LiftRaw((value, _stage, context) => {
    const dialect = context.dialect;
    const { json, walk } = Elements(value, context);
    const element = Element(
      dialect,
      walk,
      reducer.reading(ElementType(value.type)),
    );
    return {
      sql: GuardJson(
        dialect,
        json,
        "array",
        walk.aggregate(reducer.reduce(element.sql)),
      ),
      type: element.type,
    };
  });
}

/**
 * Array stages.
 *
 * Every one of them except `arr_includes` guards its operand on being a JSON array, because a path
 * and a walk both read a JSON scalar as a one-element list. The type test is NULL for SQL NULL, so
 * the same `CASE` propagates a NULL operand: a real empty array aggregates to `[]`, a non-array
 * yields NULL, and NULL stays NULL.
 *
 * The stages that walk elements are aliased scalar subqueries over the rows of `JSON_TABLE`, each
 * with an alias from `context.nextAlias()`, so two walks in one expression, or one nested inside
 * another, never collide. Every aggregation that builds an array orders by the walk's ordinal.
 * A JSON `null` element reads as SQL NULL inside a walk, and an array built from one reads it
 * back as `null`.
 *
 * - `arr_index` reads the element at the *declared* element type. A position counts from the
 *   start, and a negative one from the end; the contract says only *Position in the array*, so
 *   both are properties of the SQL rather than promises.
 * - `arr_includes` is `MEMBER OF`, with no guard, because a multi-valued index serves it and a
 *   `CASE` would hide it from the planner. It answers true for a JSON scalar equal to the element.
 * - `arr_slice` translates 0-based end-exclusive bounds onto 1-based ordinals, which is why the
 *   lower bound is a strict `>` and the upper an inclusive `<=`. Either bound counts from the end
 *   when it is negative.
 * - `arr_map` and `arr_filter` bind the element as a `Compiled` argument rather than a row, at the
 *   declared element type, and read their callback raw: it is a recorded lambda, not a value.
 *   `map` carries the body's type into the result; `filter` keeps the element type, and a NULL
 *   predicate drops the element.
 * - `arr_sum`, `arr_avg`, `arr_min` and `arr_max` read each element through the guarded JSON
 *   projection, so an element of the wrong type is NULL and the aggregate skips it. Sum of an
 *   empty array is 0 and average of one is NULL. The comparison type of `min` and `max` is the
 *   declared element type when it is orderable and `float` otherwise.
 */
export const ARRAY_STAGES: StageMap = {
  arr_index: IndexStage,
  arr_includes: IncludesStage,
  arr_slice: SliceStage,
  arr_map: MapStage,
  arr_filter: FilterStage,
  ...BuildStages(MEASURES, MeasureStage),
  ...BuildStages(REDUCERS, ReducerStage),
};
