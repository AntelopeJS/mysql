import type { InPlaceSyntax } from "../../dialect/sql-types";
import { type Sql, sql } from "../../statement";
import { Cast } from "./coerce";
import type { DecodingContext } from "./context";
import { GroupedInPlace } from "./grouped";
import { AsJson } from "./readings";
import {
  CurrentValue,
  type Relation,
  SetProjection,
  ValueRelation,
} from "./relation";
import {
  HasFlag,
  Nested,
  NestedInOrder,
  type NumberedRows,
  OrderTerms,
  type RelationFlag,
  Render,
} from "./render";
import type { Compiled } from "./sql";
import { ArrayOf, OPAQUE, type SqlType } from "./types";

/**
 * Collects a relation's rows into one JSON array in the select that reads them, empty over no row:
 * the engine's aggregate takes the relation's dedup, order and bounds itself, a grouped relation's
 * groups are collected by {@link GroupedInPlace} for the outer rows it is read for, and the one row
 * of a whole-stream aggregate is an array of one.
 */
export function CollectedInPlace(
  relation: Relation,
  inPlace: InPlaceSyntax,
  context: DecodingContext,
  outerRows: Relation | undefined,
): Compiled {
  if (relation.aggregated && relation.groupBy.length > 0) {
    return GroupedInPlace(relation, inPlace, context, outerRows);
  }
  const dialect = context.dialect;
  const value = CurrentValue(relation);
  const element = AsJson(dialect, value).sql;
  const type = ArrayOf(value.type);
  const collected = relation.aggregated
    ? dialect.sql.json.array([element])
    : inPlace.collect(element, {
        distinct: relation.distinct,
        order: OrderTerms(relation),
        offset: relation.offset,
        count: relation.limit,
      });
  relation.orderBy = [];
  relation.distinct = false;
  relation.offset = undefined;
  relation.limit = undefined;
  return {
    sql: sql`(${Render(SetProjection(relation, { sql: collected, type }))})`,
    type,
  };
}

/** The elements of a JSON array as a value-mode relation, numbered in the array's order. */
function ReadBack(
  array: Sql,
  type: SqlType,
  context: DecodingContext,
): NumberedRows {
  const dialect = context.dialect;
  const alias = context.nextAlias();
  const walk = dialect.sql.json.walk("elements", array, alias);
  const relation = SetProjection(
    ValueRelation(dialect, walk.from, alias, type),
    Cast(dialect, { sql: walk.value, type: OPAQUE }, type),
  );
  return { relation, rowNumber: walk.ordinal };
}

/**
 * Reads a relation's rows back through a walk of the array {@link CollectedInPlace} collects them
 * into, where the engine reads no outer column inside a derived table: the walk reads the outer
 * row at any depth. The rows come back as the values they yield, in value mode, numbered in their
 * order and ordered by that number only where they had an order. Rows that are still the table's
 * keep its origin, walked once or again, since every stage that reshapes them drops it.
 */
export function Walked(
  relation: Relation,
  inPlace: InPlaceSyntax,
  context: DecodingContext,
): NumberedRows {
  const type = CurrentValue(relation).type;
  const origin = relation.origin;
  const ordered = relation.orderBy.length > 0;
  const { single, absent } = relation;
  const collected = CollectedInPlace(
    relation,
    inPlace,
    context,
    context.outerRows,
  );
  const numbered = ReadBack(collected.sql, type, context);
  const walked = numbered.relation;
  walked.origin = origin;
  walked.single = single;
  walked.absent = absent;
  if (ordered) {
    walked.orderBy = [{ sql: numbered.rowNumber, descending: false }];
  }
  return numbered;
}

/**
 * Concatenates two relations' rows as values of `type`, each collected in place, and reads them
 * back through a walk, where the engine reads no outer column inside a union's derived table.
 */
export function ConcatenatedInPlace(
  sides: readonly [Relation, Relation],
  type: SqlType,
  inPlace: InPlaceSyntax,
  context: DecodingContext,
): Relation {
  const dialect = context.dialect;
  const [left, right] = sides.map(
    (side) =>
      CollectedInPlace(
        SetProjection(side, Cast(dialect, CurrentValue(side), type)),
        inPlace,
        context,
        context.outerRows,
      ).sql,
  );
  return ReadBack(dialect.sql.json.concatArrays(left, right), type, context)
    .relation;
}

/**
 * How a query nested in another one reads rows that a derived table would hold, once it has read
 * its outer row, where the engine reads no outer column inside a derived table; nothing where it
 * reads no outer row, or where the engine does.
 */
export function InPlaceFor(
  context: DecodingContext,
  readsOuterRow: boolean,
): InPlaceSyntax | undefined {
  return readsOuterRow ? context.dialect.sql.json.inPlace : undefined;
}

/**
 * The one place a *conditional* wrap is decided: every stage continuing its own relation opens by
 * naming the flags that block it, and reaches {@link Nested} through nothing else. Once the
 * subquery compiling now has read its outer row, an engine that reads no outer column inside a
 * derived table reads the rows back through {@link Walked} instead, in their order.
 *
 * A stage blocked by `ordered`, such as `group` or `distinct`, drops the order ahead of it. Every
 * other stage keeps it across the wrap, since a derived table's own `ORDER BY` orders nothing the
 * statement around it reads.
 */
export function Prepare(
  relation: Relation,
  blockedBy: readonly RelationFlag[],
  context: DecodingContext,
): Relation {
  if (!HasFlag(relation, blockedBy)) {
    return relation;
  }
  const inPlace = InPlaceFor(context, context.readsOuterRow);
  if (inPlace) {
    return Walked(relation, inPlace, context).relation;
  }
  return blockedBy.includes("ordered")
    ? Nested(relation, context)
    : NestedInOrder(relation, context);
}
