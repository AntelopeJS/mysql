import assert from "node:assert";
import type { QueryStage } from "@antelopejs/interface-database/common";

import type { Dialect } from "../../dialect";
import { type Sql, join, sql } from "../../statement";
import { ArrayOf, FLOAT, IsOpaque, OPAQUE, type SqlType } from "./types";
import { Collected } from "./json";
import { AsFloat, AsJson } from "./readings";
import type { Compiled } from "./sql";
import { DecodeFunction, RecordedLambda } from "./value";
import { FIRST_OPERAND, RequireOperand } from "./stage";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import type { DecodingContext, SubqueryProvider } from "./context";
import { BuildDocument, JsonRowSource, type RowSource } from "./row-source";
import {
  type Aggregation,
  Deduplicable,
  Maximum,
  Mean,
  Minimum,
  NamedField,
  Tally,
  Total,
} from "./stages-aggregate";
import {
  Anchored,
  CurrentValue,
  IndexColumns,
  type IndexedMember,
  type Relation,
  SetProjection,
} from "./relation";
import {
  AbsorbOrder,
  FromItem,
  JoinOn,
  Nested,
  NestedBeside,
  Numbered,
  type RelationFlag,
  Render,
} from "./render";
import { Prepare } from "./wrap";
import { IsString } from "./guards";
import { OptionsOf } from "./utils";

/**
 * What a sub-stream has reduced a group's rows to so far: what one row yields, how a field name
 * resolves against it, and a pending dedup only the terminal after it can spend.
 *
 * `source` is carried beside `value` so a named field still reaches the table's own typed column,
 * and `sum("age")` inside a group is the text `SUM(t0.age)` outside one.
 */
interface SubStream {
  source: RowSource;
  value: Compiled;
  distinct: boolean;
  /** The group's first term, a column of the group's rows or a value computed from them. */
  term: Sql;
  /**
   * The term once a `map` has made the value something that may read no column of the group's
   * rows, which ties an aggregate of the value to them; absent before any `map`.
   */
  anchor?: Sql;
}

/** One step of a sub-stream fold: a state continues it, a {@link Compiled} ends it. */
type SubStreamStage = (
  state: SubStream,
  stage: QueryStage,
  context: DecodingContext,
) => SubStream | Compiled;

/** `value` tied to the group's rows once a `map` may have left it reading none of them. */
function Kept(
  anchor: Sql | undefined,
  value: Compiled,
  context: DecodingContext,
): Compiled {
  return anchor === undefined
    ? value
    : Anchored(context.dialect, anchor, value);
}

/** What an aggregate reads: the field it named, or whatever the sub-stream currently yields. */
function Operand(
  state: SubStream,
  stage: QueryStage,
  context: DecodingContext,
): Compiled {
  const field = NamedField(stage);
  return Kept(
    state.anchor,
    field === undefined ? state.value : state.source.field(field),
    context,
  );
}

/** A new value and the source that addresses it, which is what a projection is one level up. */
function Revalued(
  state: SubStream,
  value: Compiled,
  context: DecodingContext,
): SubStream {
  return {
    source: new JsonRowSource(context.dialect, value),
    value,
    distinct: state.distinct,
    term: state.term,
    anchor: state.anchor,
  };
}

const MapSubStream: SubStreamStage = (state, stage, context) => {
  const body = DecodeFunction(RecordedLambda(stage, FIRST_OPERAND), context, [
    state.source,
  ]);
  return {
    ...Revalued(state, RequireOperand(body, stage, FIRST_OPERAND), context),
    anchor: state.term,
  };
};

/**
 * The value a pending dedup compares, where a count or the collected array spends it. A sum or an
 * average takes the value itself, since `SUM(DISTINCT)` already finds -0 equal to 0 and a decimal
 * column stays exact.
 */
function Deduped(
  state: SubStream,
  context: DecodingContext,
): Compiled | undefined {
  return state.distinct
    ? Kept(state.anchor, Deduplicable(context.dialect, state.value), context)
    : undefined;
}

const DistinctSubStream: SubStreamStage = (state, stage, context) => {
  const deduped: SubStream = { ...state, distinct: true };
  const field = NamedField(stage);
  if (field === undefined) {
    return deduped;
  }
  return Revalued(deduped, state.source.field(field), context);
};

/**
 * The one terminal that reads the *presence* of a row. A field-less count counts the group's rows
 * however they were mapped, since `COUNT(<expr>)` skips NULLs; only a pending dedup makes the value
 * the thing counted, and a field named on the count itself supersedes that dedup. The rows are
 * counted through the group's term rather than as `COUNT(*)`, which reads no column and so runs in
 * whichever query it is written in, such as the subquery of an array stage.
 */
const CountSubStream: SubStreamStage = (state, stage, context) => {
  const dialect = context.dialect;
  const field = NamedField(stage);
  if (field !== undefined) {
    return Tally(dialect, Operand(state, stage, context));
  }
  const deduped = Deduped(state, context);
  if (deduped !== undefined) {
    return Tally(dialect, deduped);
  }
  const row = Anchored(dialect, state.term, { sql: sql`1`, type: FLOAT });
  return AsFloat(dialect, sql`COUNT(${row.sql})`);
};

function AggregateSubStream(aggregate: Aggregation): SubStreamStage {
  return (state, stage, context) =>
    aggregate(context.dialect, Operand(state, stage, context), state.distinct);
}

/**
 * The stages a sub-stream accepts. A sub-stream either reduces its group to one value through one
 * of the five aggregates the whole stream uses, or it is still a stream at the end, the bare
 * parameter or a `map` or `distinct` of it, and answers the group's rows as one JSON array.
 */
const SUB_STREAM_STAGES = new Map<string, SubStreamStage>([
  ["map", MapSubStream],
  ["distinct", DistinctSubStream],
  ["count", CountSubStream],
  ["sum", AggregateSubStream(Total)],
  ["avg", AggregateSubStream(Mean)],
  ["min", AggregateSubStream(Minimum)],
  ["max", AggregateSubStream(Maximum)],
]);

function IsTerminal(step: SubStream | Compiled): step is Compiled {
  return "sql" in step;
}

/** The rows a relation reads, before any of its grouping, order, dedup or lock. */
function RowsOf(relation: Relation): Relation {
  return {
    ...relation,
    joins: [...relation.joins],
    where: [...relation.where],
    groupBy: [],
    having: [],
    orderBy: [],
    aggregated: false,
    distinct: false,
    locked: false,
  };
}

/**
 * Joins the group's rows to a number per value of `element`: the distinct values of the rows, each
 * numbered, where the engine's own comparison decides which values are one. A row whose element is
 * absent meets the number of the absent element, which no JSON null shares.
 */
function ValueNumbers(rows: Relation, element: Sql, context: DecodingContext) {
  const values = SetProjection(
    { ...RowsOf(rows), distinct: true },
    { sql: element, type: OPAQUE },
  );
  const { relation, rowNumber } = Numbered(Nested(values, context), context);
  return {
    join: JoinOn(
      "LEFT JOIN",
      FromItem(relation.from, relation.alias),
      context.dialect.sql.json.same(CurrentValue(relation).sql, element),
    ),
    number: rowNumber,
  };
}

/**
 * The group's rows as one JSON array, deduplicated where a `distinct` is pending. An engine whose
 * aggregate takes no dedup collects one element per number of the values of `rows`, and joins the
 * numbers into `joins` for the group's select to read.
 */
function CollectedRows(
  state: SubStream,
  rows: Relation,
  joins: Sql[],
  context: DecodingContext,
): Compiled {
  const dialect = context.dialect;
  const element = AsJson(
    dialect,
    Deduped(state, context) ?? Kept(state.anchor, state.value, context),
  ).sql;
  const type = ArrayOf(state.value.type);
  if (!state.distinct || dialect.sql.json.collectsDistinct) {
    return {
      sql: Collected(dialect, undefined, element, state.distinct),
      type,
    };
  }
  const numbers = ValueNumbers(rows, element, context);
  joins.push(numbers.join);
  return { sql: Collected(dialect, numbers.number, element), type };
}

/**
 * A read of a group's rows or key that MySQL or MariaDB cannot answer in one statement, refused
 * while the statement is built.
 */
class NestedGroupRead extends Error {
  public readonly code = "ANTELOPEJS_MYSQL_NESTED_GROUP_READ";
}

/**
 * Refuses, on an engine that collects nested rows in place, a read of a group's stream that MariaDB
 * answers wrong: from the mapper of another group nested in it, which then answers one inner
 * group's key for every inner group; from the callback of a `map` over an array, or from a query
 * over ordered or bounded rows, where the stream's aggregate is read inside another aggregate. A
 * slice's bounds and a filter's callback sit in the walk's `WHERE`, outside its aggregate, and
 * MariaDB answers them.
 */
function RefuseStreamRead(key: Compiled, context: DecodingContext): void {
  if (context.dialect.sql.json.inPlace === undefined) {
    return;
  }
  const place = context.streamReadPlace(key);
  const where = place.innerGroup
    ? "a group nested in the group's mapper"
    : place.elementMap
      ? "the callback of a map over an array"
      : place.window
        ? "a query over ordered or sliced rows nested in the group's mapper"
        : undefined;
  if (where !== undefined) {
    throw new NestedGroupRead(
      `A group's stream is read in ${where}, which MariaDB answers with another group's rows. Read the stream in the group's own select, or run a query per group`,
    );
  }
}

function RefuseSubStreamStage(stage: QueryStage): never {
  throw new Error(
    `The '${stage.stage}' stage cannot appear in a group's sub-stream,` +
      " though it is legal on the query outside the group",
  );
}

function RefuseSecondTerminal(stage: QueryStage): never {
  throw new Error(
    `The '${stage.stage}' stage cannot follow an aggregate in a group's sub-stream,` +
      " since an aggregate may not read another one",
  );
}

function StepSubStream(
  state: SubStream | Compiled,
  stage: QueryStage,
  context: DecodingContext,
): SubStream | Compiled {
  if (IsTerminal(state)) {
    RefuseSecondTerminal(stage);
  }
  const handler = SUB_STREAM_STAGES.get(stage.stage);
  if (!handler) {
    RefuseSubStreamStage(stage);
  }
  return handler(state, stage, context);
}

/** The group's rows as a sub-stream starts them, once the relation is grouped by its terms. */
function SeedOf(rows: Relation, value: Compiled): SubStream {
  const [first] = rows.groupBy;
  assert(first, "A group's sub-stream starts from rows grouped by a term");
  return { source: rows.source, value, distinct: false, term: first.sql };
}

function Folded(
  seed: SubStream,
  stages: QueryStage[],
  context: DecodingContext,
): SubStream | Compiled {
  return stages.reduce<SubStream | Compiled>(
    (state, stage) => StepSubStream(state, stage, context),
    seed,
  );
}

/**
 * The rows of the group the select is at, read again where a query nested in the mapper reads them:
 * a derived copy of the grouped rows with each group term beside each row, grouped again by those
 * terms, and kept where every term matches the group's own.
 *
 * The match is an aggregate in the `HAVING`, never a `WHERE`. Where a subselect reads the group's
 * column outside an aggregate, both engines run the aggregate around that subselect in the group's
 * select rather than in the query nested in the mapper, which then answers more than one row, or
 * the wrong one.
 *
 * The group's own term is read through `MIN`, which the group's select aggregates: MySQL 9.7 reads
 * a bare term that is not a column, over a group that aggregates in a temporary table, as the term
 * of one group for every group. Both engines refuse that `MIN` where the group's select is itself
 * inside the aggregate of an enclosing query, so a group two queries deep fails rather than answer
 * another group's rows.
 */
function GroupRowsAgain(grouped: Relation, context: DecodingContext): Relation {
  const terms = grouped.groupBy.map((term) => term.sql);
  const { relation: rows, columns } = NestedBeside(
    RowsOf(grouped),
    terms,
    "_group",
    context,
  );
  rows.groupBy = columns.map((column, index) => ({
    sql: column,
    type: grouped.groupBy[index].type,
  }));
  const matches = columns.map(
    (column, index) => sql`(${column} <=> MIN(${terms[index]}))`,
  );
  rows.having = [sql`(MAX(${join(matches, sql` AND `)}) = 1)`];
  return rows;
}

/**
 * A sub-stream whose value reads the row of a query nested in the mapper, which the group's select
 * cannot aggregate: a subselect inside that query, over the group's rows read again.
 */
function SubStreamAgain(
  grouped: Relation,
  stages: QueryStage[],
  context: DecodingContext,
): Compiled {
  const rows = GroupRowsAgain(grouped, context);
  const folded = Folded(SeedOf(rows, CurrentValue(rows)), stages, context);
  const joins: Sql[] = [];
  const value = IsTerminal(folded)
    ? folded
    : CollectedRows(folded, rows, joins, context);
  rows.joins.push(...joins);
  return {
    sql: sql`(${Render(SetProjection(rows, value))})`,
    type: value.type,
  };
}

/**
 * The subquery provider a `group` binds its stream parameter to, over the rows of one group.
 *
 * The rows' value is read off the relation once, before any of the mapper is decoded, and never
 * mutated, since one mapper binds this provider as many times as it names the parameter; the
 * group's term is read when the provider is called, once the relation is grouped. The joins a
 * collected dedup needs are pushed to `joins`, and left for the group's select to carry. A
 * sub-stream read inside a query nested in the mapper reads the group's rows again inside that
 * query instead, rather than an aggregate of the group's select from inside another aggregate.
 */
function SubStreamProvider(
  relation: Relation,
  key: Compiled,
  joins: Sql[],
  context: DecodingContext,
): SubqueryProvider {
  const value = CurrentValue(relation);
  const depth = context.depth;
  return (stages) => {
    RefuseStreamRead(key, context);
    return context.foldingGroupRows(key, () => {
      if (context.depth > depth) {
        return SubStreamAgain(relation, stages, context);
      }
      const folded = Folded(SeedOf(relation, value), stages, context);
      return IsTerminal(folded)
        ? folded
        : CollectedRows(folded, relation, joins, context);
    });
  };
}

/** Everything that blocks a whole-stream aggregate. */
const GROUP_BLOCKERS: readonly RelationFlag[] = [
  "projection",
  "limit",
  "offset",
  "distinct",
  "aggregated",
];

function GroupName(stage: QueryStage): string {
  const name: unknown = OptionsOf(stage)?.index;
  assert(
    IsString(name),
    "The 'group' stage is missing the index or field to group on",
  );
  return name;
}

/** The kinds of key part beside which MySQL keeps a declared -0 and 0 in groups of their own. */
const SPLITS_ZERO_BESIDE: ReadonlySet<SqlType["kind"]> = new Set([
  "text",
  "array",
  "json",
]);

/**
 * The parts of the group key as the `GROUP BY` compares them, with a negative zero read as 0
 * wherever an engine would keep it apart: an opaque JSON part, whose text MariaDB groups as is, and
 * a declared number beside a text or JSON part, which MySQL groups by sign. Any other part stays
 * bare, so a key of declared numbers, booleans and timestamps is still one an index can serve.
 */
function GroupTerms(
  dialect: Dialect,
  members: readonly IndexedMember[],
): IndexedMember[] {
  const mixed = members.some((member) =>
    SPLITS_ZERO_BESIDE.has(member.value.type.kind),
  );
  return members.map((member) =>
    IsOpaque(member.value.type) || (mixed && members.length > 1)
      ? { ...member, value: Deduplicable(dialect, member.value) }
      : member,
  );
}

/** A part of the key read through `MIN`, an aggregate of the group, which keeps its type. */
function AggregatedPart(member: IndexedMember): IndexedMember {
  return {
    ...member,
    value: { sql: sql`MIN(${member.value.sql})`, type: member.value.type },
  };
}

/**
 * The key the mapper reads, with a negative zero read as 0 in every part: one part is the value
 * itself; a compound index is a document of its parts, by field name.
 */
function GroupValue(
  members: readonly IndexedMember[],
  context: DecodingContext,
): Compiled {
  const [only] = members;
  if (members.length === 1) {
    return only.value;
  }
  return BuildDocument(
    context.dialect,
    members.map((member) => ({ name: member.name, ...member.value })),
  );
}

/**
 * Folds the stream into one row per group, with the mapper's result as each row's value: one
 * `GROUP BY` over the rows the pipeline selected, whose select list holds the mapper's aggregates.
 *
 * The grouping is settled before the mapper is decoded, so no decoded value is discarded. Each
 * part of the index is a term, and the mapper reaches only the group value, built from those terms,
 * and sub-stream aggregates. So the statement stays valid under `ONLY_FULL_GROUP_BY` wherever each
 * term is a bare column, a declared field; a term the server computes, such as an overflow member,
 * relies on the session pin leaving that mode off.
 *
 * The relation is left `aggregated` and not `single`: a later `count()` wraps and counts the groups.
 * A group keeps no order of the rows ahead of it, which a group's rows are collected without and
 * both engines drop from a derived table a `GROUP BY` reads, so the order is dropped in place.
 */
const GroupStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, GROUP_BLOCKERS, context);
  AbsorbOrder(prepared);
  const columns = IndexColumns(prepared, GroupName(stage));
  const parts = columns.map((member) => ({
    ...member,
    value: Deduplicable(context.dialect, member.value),
  }));
  const value = context.groupKey(
    GroupValue(parts, context),
    context.dialect.sql.rows.aggregatesGroupTerms
      ? GroupValue(parts.map(AggregatedPart), context)
      : GroupValue(parts, context),
  );
  prepared.groupBy.push(
    ...GroupTerms(context.dialect, columns).map((member) => member.value),
  );
  const joins: Sql[] = [];
  const mapped = context.mappingGroup(value, () =>
    DecodeFunction(RecordedLambda(stage, FIRST_OPERAND), context, [
      SubStreamProvider(prepared, value, joins, context),
      value,
    ]),
  );
  prepared.joins.push(...joins);
  const grouped = SetProjection(
    prepared,
    RequireOperand(mapped, stage, FIRST_OPERAND),
  );
  grouped.aggregated = true;
  return grouped;
};

export const GROUP_STAGES: PipelineStageMap = {
  group: GroupStage,
};
