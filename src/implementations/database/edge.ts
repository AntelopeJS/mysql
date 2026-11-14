import type { InPlaceSyntax } from "../../dialect/sql-types";
import { type Sql, join, sql } from "../../statement";
import type { DecodingContext } from "./context";
import {
  IndexColumns,
  type OrderTerm,
  type Relation,
  type SortedBy,
  SortedTerms,
  type TableOrigin,
  TableRelation,
} from "./relation";
import {
  FromItem,
  IdentityColumns,
  JoinOn,
  OrderTerms,
  Render,
  SINGLE_ROW,
} from "./render";
import { OPAQUE } from "./types";
import { MAX_INSTANCE_ID_CHARS, MAX_KEY_CHARS } from "./utils";

const COMMA = sql`, `;
const AND = sql` AND `;

/** A term `orderBy` sorted by, which the edge row reads again at its own alias. */
type SortedTerm = OrderTerm & { readonly sortedBy: SortedBy };

/**
 * The most bytes one row's identity takes as an element of the held array: every character of
 * both parts escaped as `\u` and four digits, beside the two brackets, four quotes and the `", "`
 * MariaDB writes inside the element, and the comma before the next one.
 */
const IDENTITY_JSON_BYTES = (MAX_KEY_CHARS + MAX_INSTANCE_ID_CHARS) * 6 + 9;

/**
 * The most rows a slice holds the identities of in one aggregate: as many as always fit in the
 * 16 MiB `max_allowed_packet` MariaDB starts with, the array's own brackets included, past which
 * it cuts an aggregate short. A walk
 * holds each row whole, its identity included, so a slice whose identities pass a lower bound
 * would have passed it through a walk as well.
 */
const HELD_SLICE_ROWS = Math.floor((2 ** 24 - 1) / IDENTITY_JSON_BYTES);

/** Whether `orderBy` sorted by the term, by a value the engine sorts by whole. */
function IsSorted(term: OrderTerm): term is SortedTerm {
  return term.sortedBy?.whole === true;
}

/**
 * Whether the relation's bounds keep a row by its place among the table's own rows alone: the
 * rows are the table's, with no join, group, dedup or aggregate ahead of the bounds.
 */
function SlicesTableRows(relation: Relation): boolean {
  return (
    relation.joins.length === 0 &&
    relation.groupBy.length === 0 &&
    !relation.distinct &&
    !relation.aggregated &&
    (relation.limit !== undefined || relation.offset !== undefined)
  );
}

/** The relation's rows in their order made total by each row's identity, which no two rows share. */
function TotallyOrdered(relation: Relation): Relation {
  const identity = IdentityColumns(relation).map((column): OrderTerm => ({
    sql: column,
    descending: false,
  }));
  return {
    ...relation,
    where: [...relation.where],
    orderBy: [...relation.orderBy, ...identity],
    offset: undefined,
    limit: undefined,
    locked: false,
  };
}

/** One value of the relation's rows, as a select of it reads it. */
function Selected(relation: Relation, value: Sql): Sql {
  return sql`(${Render({ ...relation, projection: { sql: value, type: OPAQUE } })})`;
}

/**
 * The row at a position of the relation's rows, joined to them once: its identity held in a
 * one-row table, each part SQL NULL where the relation has no row there, and the row itself read
 * by that identity at an alias of its own. The rows are ordered by their order made total by each
 * row's identity, so every read of the edge reads the same row.
 */
function EdgeAt(
  relation: Relation,
  table: TableOrigin,
  position: number,
  inPlace: InPlaceSyntax,
  context: DecodingContext,
): Edge {
  const identity = IdentityColumns(relation);
  const ordered: Relation = {
    ...TotallyOrdered(relation),
    offset: position,
    limit: SINGLE_ROW,
  };
  const alias = context.nextAlias();
  const array = relation.dialect.sql.json.array(identity);
  const held = inPlace.heldTexts(
    Selected(ordered, array),
    identity.length,
    alias,
  );
  const row = TableRelation(
    relation.dialect,
    relation.from,
    context.nextAlias(),
    table,
  );
  const atEdge = IdentityColumns(row).map(
    (column, part) => sql`${column} = ${held.columns[part]}`,
  );
  return {
    joins: [
      sql`CROSS JOIN ${FromItem(held.from, alias)}`,
      JoinOn("LEFT JOIN", FromItem(row.from, row.alias), join(atEdge, AND)),
    ],
    identity: sql`(${join(held.columns, COMMA)})`,
    held: sql`(${held.columns[held.columns.length - 1]} IS NOT NULL)`,
    value: ({ name, part }) =>
      SortedTerms(IndexColumns(row, name), name, false)[part].sql,
  };
}

/** The row at one edge of a slice, as {@link EdgeAt} joins it. */
interface Edge {
  readonly joins: readonly Sql[];
  readonly identity: Sql;
  /** Whether the relation has a row at the edge's position. */
  readonly held: Sql;
  /** The edge row's value of a term `orderBy` sorted by. */
  value(sortedBy: SortedBy): Sql;
}

/**
 * The identities of the rows within a slice of at most {@link HELD_SLICE_ROWS} rows, chosen by
 * the engine's own sort, held in one aggregate and joined to the rows by primary key.
 */
function HeldSlice(
  relation: Relation,
  offset: number,
  count: number,
  inPlace: InPlaceSyntax,
  context: DecodingContext,
): Sql {
  const identity = IdentityColumns(relation);
  const ordered = TotallyOrdered(relation);
  const collected = inPlace.collect(relation.dialect.sql.json.array(identity), {
    distinct: false,
    order: OrderTerms(ordered),
    offset,
    count,
  });
  const alias = context.nextAlias();
  const held = inPlace.heldElements(
    Selected({ ...ordered, orderBy: [] }, collected),
    identity.length,
    alias,
  );
  const atHeld = identity.map(
    (column, part) => sql`${column} = ${held.columns[part]}`,
  );
  return JoinOn("JOIN", FromItem(held.from, alias), join(atHeld, AND));
}

/**
 * Whether `first` sorts strictly before `second` under one term, with SQL NULL first in an
 * ascending order and last in a descending one, as MariaDB sorts it.
 */
function Precedes(first: Sql, second: Sql, descending: boolean): Sql {
  const [low, high] = descending ? [second, first] : [first, second];
  return sql`((${low} IS NULL AND ${high} IS NOT NULL) OR ${low} < ${high})`;
}

/**
 * Whether the row sorts no later than the edge row, `upper`, or no earlier than it: each term in
 * turn, and the identity once every term ties, which no two rows share.
 */
function Within(
  relation: Relation,
  terms: readonly SortedTerm[],
  edge: Edge,
  upper: boolean,
): Sql {
  const row = sql`(${join(IdentityColumns(relation), COMMA)})`;
  const identity = sql`${row} ${upper ? sql`<=` : sql`>=`} ${edge.identity}`;
  return terms.reduceRight((later, term) => {
    const value = edge.value(term.sortedBy);
    const [first, second] = upper ? [term.sql, value] : [value, term.sql];
    return sql`(${Precedes(first, second, term.descending)} OR (${term.sql} <=> ${value} AND ${later}))`;
  }, identity);
}

/**
 * Bounds a slice of the table's own rows in place rather than by a `LIMIT`, so that where the
 * engine reads no outer column inside a derived table the rows that follow the bounds stay the
 * table's, rather than coming back through a walk of one aggregate of whole rows, which MariaDB
 * cuts short past `max_allowed_packet`. A slice of at most {@link HELD_SLICE_ROWS} rows is joined
 * to the identities of its rows, held at a size that always fits. A longer one is bounded by the
 * rows at its edges, the one at the offset and the one at the offset plus the count less one,
 * where it is ordered only by values the engine sorts by whole. Any other relation is returned as
 * it is.
 */
export function BoundedInPlace(
  relation: Relation,
  inPlace: InPlaceSyntax,
  context: DecodingContext,
): Relation {
  const table = relation.table;
  if (table === undefined || !SlicesTableRows(relation)) {
    return relation;
  }
  const offset = relation.offset ?? 0;
  const count = relation.limit;
  const bounded: Relation = {
    ...relation,
    joins: [],
    where: [...relation.where],
    offset: undefined,
    limit: undefined,
  };
  if (count === 0) {
    bounded.where.push(sql`FALSE`);
    return bounded;
  }
  if (count !== undefined && count <= HELD_SLICE_ROWS) {
    bounded.joins.push(HeldSlice(relation, offset, count, inPlace, context));
    return bounded;
  }
  if (!relation.orderBy.every(IsSorted)) {
    return relation;
  }
  const terms = relation.orderBy.filter(IsSorted);
  if (offset > 0) {
    const lower = EdgeAt(relation, table, offset, inPlace, context);
    bounded.joins.push(...lower.joins);
    bounded.where.push(
      sql`(${lower.held} AND ${Within(relation, terms, lower, false)})`,
    );
  }
  const last = count === undefined ? undefined : offset + count - 1;
  if (last !== undefined && last <= Number.MAX_SAFE_INTEGER) {
    const upper = EdgeAt(relation, table, last, inPlace, context);
    bounded.joins.push(...upper.joins);
    bounded.where.push(
      sql`(NOT ${upper.held} OR ${Within(relation, terms, upper, true)})`,
    );
  }
  return bounded;
}
