import { IsQueryStage } from "@antelopejs/interface-database/common";
import type { QueryStage } from "@antelopejs/interface-database/common";

import { sql } from "../../statement";
import { ArrayOf } from "./types";
import { Collected } from "./json";
import { AsJson } from "./readings";
import type { Compiled } from "./sql";
import { FIRST_OPERAND } from "./stage";
import { ParameterKey } from "./value";
import { type DecodingContext, IsSubqueryProvider } from "./context";
import { CurrentValue, type Relation, SetProjection } from "./relation";
import { Numbered, Prepare, type RelationFlag, Render } from "./render";

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
 * Collects every row of a nested query into one JSON array, in the order the query asked for. An
 * ordered query's rows are numbered in that order first, and the aggregate orders by the number.
 */
function Aggregated(relation: Relation, context: DecodingContext): Compiled {
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
  const relation = context.relation(stages);
  if (!relation.single) {
    return Aggregated(relation, context);
  }
  const value = CurrentValue(relation);
  return {
    sql: sql`(${Render(SetProjection(relation, value))})`,
    type: value.type,
  };
}
