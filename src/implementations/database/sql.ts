import type { Dialect } from "../../dialect";
import type { Conversion } from "../../dialect/external";
import type { ConstantJson } from "../../dialect/sql-types";
import type { KeyColumn, ValueKey } from "./paths";
import { BOOL, FLOAT, type SqlType, TEXT, TIMESTAMP } from "./types";
import { Bind, type Sql, ident, join, sql } from "../../statement";

export type { ConstantJson } from "../../dialect/sql-types";

/**
 * A key column that holds the value a {@link Compiled} reads, as a comparison can use it: by name,
 * at the alias of the row it belongs to. A `prefix` key holds the value's first `width`
 * characters, so a comparison served by it also tests the value itself.
 *
 * `rows` says where the column holds the value: on `every` row, or only on the rows where the
 * column is `set`. A value that falls back to a default is the read the column keys wherever that
 * read is present, and the column is NULL wherever the default stands in, so a bound through it
 * keeps the rows it is NULL on.
 */
export interface KeyReference {
  readonly column: Sql;
  readonly key: KeyColumn;
  readonly rows: "every" | "set";
  /**
   * The equalities that pin the columns an index holds ahead of `column` to the one kind of value
   * the column orders: for a value key's number column, the tag of numbers or of booleans.
   */
  readonly pins: readonly Equality[];
  /**
   * The rank whose tag every value `column` holds of the kind compared leads with, for a value key's
   * text column: the compared operand is tagged the same way, and an ordering stays within the rank.
   */
  readonly tag?: number;
  /** Where the value is absent, which a key `set` only on some rows keeps. */
  readonly absent: Sql;
}

/** A column equal to a value, one part of the bound a key column narrows rows by. */
export interface Equality {
  readonly column: Sql;
  readonly value: Sql;
}

/** Equalities as one conjunction, which a list of keys and a pinned bound both spell. */
export function Equal(equalities: readonly Equality[]): Sql {
  return join(
    equalities.map(({ column, value }) => sql`${column} = ${value}`),
    sql` AND `,
  );
}

/**
 * The columns of a value key at the alias of the row it belongs to, which a selection by the value
 * of no declared type it keys is narrowed through, and which order it.
 */
export interface ValueReference {
  readonly text: Sql;
  readonly number: Sql;
  readonly key: ValueKey;
}

/**
 * The physical column of a table's own row a JSON read starts from, as the key columns see it.
 * `keys` are the table's key columns at the row's alias, which only the table itself has, not a
 * subselect that left them out, and `values` its value keys among them. `elements` are the columns
 * a multi-valued index is built over.
 */
export interface RowColumn {
  readonly alias: string;
  readonly keys: readonly KeyColumn[];
  readonly values: readonly ValueKey[];
  readonly elements: readonly string[];
  readonly source: string;
}

/**
 * Where a value read out of JSON comes from: a document and the path of keys below it. Carried while
 * the value is still that read, so a read of one more key reads the longer path from the document
 * in one step, and a read of a table's own `column` that lands on what a key column holds can name
 * the key column instead.
 */
export interface ValuePath {
  readonly document: Sql;
  readonly path: readonly string[];
  readonly column?: RowColumn;
}

export interface Compiled {
  sql: Sql;
  type: SqlType;
  /** The key column holding this value, where a declared index keys on it. */
  key?: KeyReference;
  /** The document and JSON path this value reads, while it is still exactly that read. */
  path?: ValuePath;
  /**
   * The document and JSON path a default stands in for: this value is that read on every row where
   * the read is present, and the default elsewhere.
   */
  defaulted?: ValuePath;
  /** The column underneath, in its own type, where `sql` reads it converted (external relations only). */
  native?: NativeOperand;
}

/**
 * A column of a relation the adapter did not create, as a comparison can use it without converting
 * it, which is what keeps the database's own indexes serving the comparison.
 *
 * `sql` is the bare column, or a row of them for a composite key, and `order` the columns a sort
 * names one by one. `bind` converts the other operand, already read as the column's declared kind,
 * into the column's own type for `operator`, so that a value the type cannot hold matches nothing
 * rather than failing the statement. `numeric` says an aggregate may read the column directly,
 * which an exact type such as `DECIMAL` or `BIGINT` needs to sum without drifting. `type` is the
 * column's native type: two operands of one type compare bare. `present` is where the column holds
 * a value a read answers, for a column that may hold one a read answers as absent, such as a zero
 * date: a comparison through the bare column holds only there.
 */
export interface NativeOperand {
  readonly sql: Sql;
  readonly order: readonly Sql[];
  readonly bind: Conversion;
  readonly numeric: boolean;
  readonly type: string;
  readonly present?: Sql;
}

/** References a column of an aliased relation; the single spelling every compiled fragment uses. */
export function QualifiedColumn(alias: string, column: string): Sql {
  return sql`${ident(alias)}.${ident(column)}`;
}

/**
 * Whether a compiled fragment reads a column of an aliased relation. Every fragment spells a column
 * through {@link QualifiedColumn}, and a quoted identifier never occurs inside another, so the
 * fragment's text holds that spelling exactly where it reads the column.
 */
export function ReadsColumn(
  fragment: Sql,
  alias: string,
  column: string,
): boolean {
  return Bind(fragment).sql.includes(Bind(QualifiedColumn(alias, column)).sql);
}

/** A bound text. */
export function TextParam(dialect: Dialect, value: string): Compiled {
  return { sql: dialect.sql.scalar.bind.text(value), type: TEXT };
}

/** A bound number, read as a double. */
export function NumberParam(dialect: Dialect, value: number): Compiled {
  return { sql: dialect.sql.scalar.bind.float(value), type: FLOAT };
}

/** A bound boolean. */
export function BooleanParam(dialect: Dialect, value: boolean): Compiled {
  return { sql: dialect.sql.scalar.bind.bool(value), type: BOOL };
}

/** A bound instant. */
export function InstantParam(dialect: Dialect, value: Date): Compiled {
  return { sql: dialect.sql.scalar.bind.timestamp(value), type: TIMESTAMP };
}

/** A JSON document bound whole, of the type the caller read off it. */
export function JsonParam(
  dialect: Dialect,
  value: ConstantJson,
  type: SqlType,
): Compiled {
  return { sql: dialect.sql.scalar.bind.json(value), type };
}
