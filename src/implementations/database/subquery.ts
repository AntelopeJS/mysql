import { IsQueryStage } from "@antelopejs/interface-database/common";
import type { QueryStage } from "@antelopejs/interface-database/common";

import { sql } from "../../statement";
import type { InPlaceSyntax } from "../../dialect/sql-types";
import { ArrayOf, TEXT } from "./types";
import { Collected } from "./json";
import { AsJson } from "./readings";
import type { Compiled } from "./sql";
import { FIRST_OPERAND } from "./stage";
import { ParameterKey } from "./value";
import { type DecodingContext, IsSubqueryProvider } from "./context";
import { BuildDocument, JsonRowSource } from "./row-source";
import { CurrentValue, type Relation, SetProjection } from "./relation";
import {
  Numbered,
  OrderTerms,
  Prepare,
  type RelationFlag,
  Render,
} from "./render";

/**
 * What has already decided *which* rows there are blocks the aggregate from absorbing. Shorter
 * than the stream list by `projection`, which is exactly what this aggregate collects.
 */
const SUBQUERY_BLOCKERS: readonly RelationFlag[] = [
  "limit",
  "offset",
  "distinct",
  "aggregated",
];

/**
 * Collects a nested query's groups without a derived table over them: a walk of the distinct group
 * keys, each the text a dedup compares every term by, reads the outer row, and each key's group is
 * the grouped select restricted to the rows whose terms have that text, so it reads the outer row
 * too. It reads the rows once per group. The select groups by the texts, which the walk carries
 * exactly, where a JSON value read back from the walk is reformatted; the session leaves
 * `ONLY_FULL_GROUP_BY` off, so the mapper still reads a term.
 */
function GroupedInPlace(
  relation: Relation,
  inPlace: InPlaceSyntax,
  context: DecodingContext,
): Compiled {
  const dialect = context.dialect;
  const texts = relation.groupBy.map((term) =>
    inPlace.dedupText(AsJson(dialect, term).sql),
  );
  const key = BuildDocument(
    dialect,
    texts.map((text, part) => ({ name: `k${part}`, sql: text, type: TEXT })),
  );
  const keys = SetProjection(
    { ...relation, groupBy: [], aggregated: false },
    {
      sql: inPlace.collect(key.sql, { distinct: true }),
      type: ArrayOf(key.type),
    },
  );
  const walk = dialect.sql.json.walk(
    "elements",
    sql`(${Render(keys)})`,
    context.nextAlias(),
  );
  const walked = new JsonRowSource(dialect, {
    sql: walk.value,
    type: key.type,
  });
  const group = Render({
    ...relation,
    groupBy: texts.map((text) => ({ sql: text, type: TEXT })),
    where: [
      ...relation.where,
      ...texts.map((text, part) =>
        dialect.sql.rows.nullSafeEqual(text, walked.field(`k${part}`).sql),
      ),
    ],
  });
  const value = CurrentValue(relation);
  const element = AsJson(dialect, { sql: sql`(${group})`, type: value.type });
  return {
    sql: walk.aggregate(Collected(dialect, walk.ordinal, element.sql)),
    type: ArrayOf(value.type),
  };
}

/**
 * Collects the rows a nested query answers into one JSON array in place, where the engine's
 * aggregate takes the query's dedup, order and bounds itself, and a grouped query through
 * {@link GroupedInPlace} where it reads the outer row.
 */
function AggregatedInPlace(
  relation: Relation,
  readsOuterRow: boolean,
  context: DecodingContext,
): Compiled | undefined {
  const inPlace = context.dialect.sql.json.inPlace;
  if (!inPlace) {
    return undefined;
  }
  if (relation.aggregated) {
    return readsOuterRow && relation.groupBy.length > 0
      ? GroupedInPlace(relation, inPlace, context)
      : undefined;
  }
  const rows = {
    distinct: relation.distinct,
    order: OrderTerms(relation),
    offset: relation.offset,
    count: relation.limit,
  };
  relation.orderBy = [];
  relation.distinct = false;
  relation.offset = undefined;
  relation.limit = undefined;
  const value = CurrentValue(relation);
  const type = ArrayOf(value.type);
  const collected = inPlace.collect(AsJson(context.dialect, value).sql, rows);
  return {
    sql: sql`(${Render(SetProjection(relation, { sql: collected, type }))})`,
    type,
  };
}

/**
 * Collects every row of a nested query into one JSON array, in the order the query asked for. An
 * ordered query's rows are numbered in that order first, and the aggregate orders by the number.
 */
function Aggregated(
  relation: Relation,
  readsOuterRow: boolean,
  context: DecodingContext,
): Compiled {
  const inPlace = AggregatedInPlace(relation, readsOuterRow, context);
  if (inPlace) {
    return inPlace;
  }
  const prepared = Prepare(relation, SUBQUERY_BLOCKERS, context);
  const numbered =
    prepared.orderBy.length > 0 ? Numbered(prepared, context) : undefined;
  const rows = numbered?.relation ?? prepared;
  rows.orderBy = [];
  const value = CurrentValue(rows);
  const type = ArrayOf(value.type);
  const collected = Collected(
    context.dialect,
    numbered?.rowNumber,
    AsJson(context.dialect, value).sql,
  );
  return {
    sql: sql`(${Render(SetProjection(rows, { sql: collected, type }))})`,
    type,
  };
}

/** A lambda parameter bound to a compilation of its own, with the rest of the stages handed to it. */
function ProvidedSubquery(
  stages: QueryStage[],
  context: DecodingContext,
): Compiled | undefined {
  const [head, ...rest] = stages;
  if (!IsQueryStage(head, "arg")) {
    return undefined;
  }
  const binding = context.arg(ParameterKey(head.args[FIRST_OPERAND]));
  return IsSubqueryProvider(binding) ? binding(rest) : undefined;
}

/**
 * Compiles a whole query appearing as a *value* into a scalar subselect.
 *
 * A query headed by an `arg` is a lambda parameter the enclosing stage bound to a subquery
 * provider, which is how a `group`'s mapper reaches the rows of its own group; it is tested before
 * the query is compiled as a table query, which it is not.
 *
 * A single-row query is the subselect itself, which yields SQL NULL when it read no row, while a
 * stream is aggregated into a JSON array. The projection is set to whatever the relation yields
 * before either renders, which keeps exactly one column in the subselect.
 */
export function CompileSubquery(
  stages: QueryStage[],
  context: DecodingContext,
): Compiled {
  const provided = ProvidedSubquery(stages, context);
  if (provided) {
    return provided;
  }
  const { relation, readsOuterRow } = context.subqueryRelation(stages);
  if (!relation.single) {
    return Aggregated(relation, readsOuterRow, context);
  }
  const value = CurrentValue(relation);
  return {
    sql: sql`(${Render(SetProjection(relation, value))})`,
    type: value.type,
  };
}
