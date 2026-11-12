import assert from "node:assert";

import { Bind, type Sql, ident, join, sql } from "../../statement";
import type { DecodingContext } from "./context";
import { EXTRA_COLUMN, ID_COLUMN, INSTANCE_COLUMN } from "./utils";
import { QualifiedColumn } from "./sql";
import { DeclaredColumns, PhysicalOrder, type TableModel } from "./fields";
import { ExternalNames } from "./external-row-source";
import {
  OUTPUT_COLUMN,
  type Relation,
  RequireOrigin,
  TableRelation,
  ValueRelation,
} from "./relation";

const COMMA = sql`, `;
const AND = sql` AND `;

/** An external relation's select list: each member read as its value, under its own name. */
function ExternalColumns(relation: Relation, model: TableModel): Sql[] {
  return ExternalNames(model).map(
    (name) => sql`${relation.source.field(name).sql} AS ${ident(name)}`,
  );
}

function RowNames(relation: Relation): string[] {
  const origin = RequireOrigin(relation);
  if (origin.model.external) {
    return ExternalNames(origin.model);
  }
  return PhysicalOrder(
    ID_COLUMN,
    INSTANCE_COLUMN,
    DeclaredColumns(origin.model),
    EXTRA_COLUMN,
  );
}

function RowColumns(relation: Relation): Sql[] {
  const model = RequireOrigin(relation).model;
  if (model.external) {
    return ExternalColumns(relation, model);
  }
  return RowNames(relation).map((column) =>
    QualifiedColumn(relation.alias, column),
  );
}

function SelectList(relation: Relation): Sql {
  const projection = relation.projection;
  if (!projection) {
    return join(RowColumns(relation), COMMA);
  }
  return sql`${projection.sql} AS ${ident(OUTPUT_COLUMN)}`;
}

type ClauseBuilder = (relation: Relation) => Sql | undefined;

function SelectClause(relation: Relation): Sql {
  const modifier = relation.distinct ? sql`DISTINCT ` : sql``;
  return sql`SELECT ${modifier}${SelectList(relation)}`;
}

function FromItem(from: Sql, alias: string): Sql {
  return sql`${from} AS ${ident(alias)}`;
}

function FromClause(relation: Relation): Sql {
  return sql`FROM ${FromItem(relation.from, relation.alias)}`;
}

const JOIN_KEYWORDS = { JOIN: sql`JOIN`, "LEFT JOIN": sql`LEFT JOIN` };

/** The joins every engine spells alike; a lookup's lateral is the dialect's to spell. */
export type JoinKind = keyof typeof JOIN_KEYWORDS;

/** A join of already-rendered FROM text at an alias, on a condition. */
export function JoinOn(kind: JoinKind, from: Sql, alias: string, on: Sql): Sql {
  return sql`${JOIN_KEYWORDS[kind]} ${FromItem(from, alias)} ON ${on}`;
}

function JoinClauses(relation: Relation): Sql | undefined {
  if (relation.joins.length === 0) {
    return undefined;
  }
  return join(relation.joins, sql` `);
}

function WhereClause(relation: Relation): Sql | undefined {
  if (relation.where.length === 0) {
    return undefined;
  }
  return sql`WHERE ${join(relation.where, AND)}`;
}

function GroupByClause(relation: Relation): Sql | undefined {
  if (relation.groupBy.length === 0) {
    return undefined;
  }
  return sql`GROUP BY ${join(
    relation.groupBy.map((term) => term.sql),
    COMMA,
  )}`;
}

function OrderTerms(relation: Relation): Sql | undefined {
  if (relation.orderBy.length === 0) {
    return undefined;
  }
  const terms = relation.orderBy.map((term) =>
    term.descending ? sql`${term.sql} DESC` : sql`${term.sql} ASC`,
  );
  return join(terms, COMMA);
}

function OrderByClause(relation: Relation): Sql | undefined {
  const terms = OrderTerms(relation);
  return terms === undefined ? undefined : sql`ORDER BY ${terms}`;
}

/**
 * Takes the order terms off the relation, for a stream aggregate that absorbs it: no ordering can
 * change what the aggregate reduces to. The refusal asserts that a term carries no bound value: a
 * discarded term holding one would leave nothing wrong in the text, but an order term that ever
 * decodes an argument has to be rendered into a subselect instead, and this says so where that
 * edit lands.
 */
export function AbsorbOrder(relation: Relation): void {
  const terms = OrderTerms(relation);
  assert(
    terms === undefined || Bind(terms).args.length === 0,
    "An order term must carry no bound value, since absorbing an aggregate discards it",
  );
  relation.orderBy = [];
}

/** The row count that makes a relation answer at most one row, which `nth` and a lookup take. */
export const SINGLE_ROW = 1;

function LimitClause(relation: Relation): Sql | undefined {
  return relation.dialect.sql.rows.limit(relation.limit, relation.offset);
}

/** The clauses that choose the rows, between the select list and their order. */
const BODY: ClauseBuilder[] = [
  FromClause,
  JoinClauses,
  WhereClause,
  GroupByClause,
];

const CLAUSES: ClauseBuilder[] = [
  SelectClause,
  ...BODY,
  OrderByClause,
  LimitClause,
];

function RenderClauses(relation: Relation, builders: ClauseBuilder[]): Sql {
  const clauses = builders
    .map((build) => build(relation))
    .filter((clause) => clause !== undefined);
  return join(clauses, sql` `);
}

export function Render(relation: Relation): Sql {
  return RenderClauses(relation, CLAUSES);
}

/**
 * Renders the relation into a subselect and starts a fresh one over it, addressing its output at a
 * new alias.
 *
 * `Prepare` is the door to a *conditional* wrap; `Nested` is the door for a relation becoming a
 * FROM item of another relation, where the wrap is unconditional. Row mode survives, because the
 * rendered select list keeps the physical column names, but the key columns do not: the select
 * list holds the stored columns only. `single` and `absent` carry through; `aggregated` does not.
 */
export function Nested(relation: Relation, context: DecodingContext): Relation {
  return Wrapped(relation, sql`(${Render(relation)})`, context);
}

/** A fresh relation over a subselect of `relation`, addressing its output as {@link Nested} does. */
function Wrapped(
  relation: Relation,
  from: Sql,
  context: DecodingContext,
): Relation {
  const alias = context.nextAlias();
  const projection = relation.projection;
  const wrapped = projection
    ? ValueRelation(relation.dialect, from, alias, projection.type)
    : TableRelation(
        relation.dialect,
        from,
        alias,
        RequireOrigin(relation),
        "output",
      );
  wrapped.single = relation.single;
  wrapped.absent = relation.absent;
  return wrapped;
}

const ROW_NUMBER_COLUMN = "_row";

/** A name for one more column, free of every name the select list gives; MySQL folds their case. */
function FreeColumn(relation: Relation): string {
  const selected = relation.projection ? [OUTPUT_COLUMN] : RowNames(relation);
  const taken = new Set(selected.map((name) => name.toLowerCase()));
  let name = ROW_NUMBER_COLUMN;
  while (taken.has(name)) {
    name = `_${name}`;
  }
  return name;
}

/** A relation whose rows are numbered in the order they had, and the column holding the number. */
export interface NumberedRows {
  relation: Relation;
  rowNumber: Sql;
}

/**
 * Numbers the relation's rows in its own order and starts a fresh relation over them, ordered by
 * that number, so a row bound the statement computes can be a comparison with it: the engine takes
 * only a constant or a bound value as a `LIMIT`. The window runs after every clause of the select
 * it is in, so the caller has wrapped a row bound, an aggregate and a dedup first.
 */
export function Numbered(
  relation: Relation,
  context: DecodingContext,
): NumberedRows {
  const column = FreeColumn(relation);
  const terms = OrderTerms(relation);
  const order = terms === undefined ? sql`` : sql`ORDER BY ${terms}`;
  const select = sql`${SelectClause(relation)}, ROW_NUMBER() OVER (${order}) AS ${ident(column)}`;
  const body = RenderClauses(relation, BODY);
  const numbered = Wrapped(relation, sql`(${select} ${body})`, context);
  const rowNumber = QualifiedColumn(numbered.alias, column);
  numbered.orderBy = [{ sql: rowNumber, descending: false }];
  return { relation: numbered, rowNumber };
}

export type RelationFlag =
  | "projection"
  | "limit"
  | "offset"
  | "distinct"
  | "ordered"
  | "aggregated";

/**
 * The flags that block absorbing a predicate into `WHERE`, which is the relation's own clause order.
 * A `WHERE` runs before the clauses that choose rows and cannot mention an aggregate, and a pending
 * projection blocks it as it blocks every stage that resolves a field.
 */
export const WHERE_BLOCKERS: readonly RelationFlag[] = [
  "projection",
  "limit",
  "offset",
  "distinct",
  "aggregated",
];

type RelationPredicate = (relation: Relation) => boolean;

const FLAG_PREDICATES: Record<RelationFlag, RelationPredicate> = {
  projection: (relation) => relation.projection !== undefined,
  limit: (relation) => relation.limit !== undefined,
  offset: (relation) => relation.offset !== undefined,
  distinct: (relation) => relation.distinct,
  ordered: (relation) => relation.orderBy.length > 0,
  aggregated: (relation) => relation.aggregated,
};

/** Whether any of the flags is set on the relation. */
export function HasFlag(
  relation: Relation,
  flags: readonly RelationFlag[],
): boolean {
  return flags.some((flag) => FLAG_PREDICATES[flag](relation));
}

/**
 * The one place a *conditional* wrap is decided: every stage continuing its own relation opens by
 * naming the flags that block it, and reaches {@link Nested} through nothing else.
 */
export function Prepare(
  relation: Relation,
  blockedBy: readonly RelationFlag[],
  context: DecodingContext,
): Relation {
  return HasFlag(relation, blockedBy) ? Nested(relation, context) : relation;
}
