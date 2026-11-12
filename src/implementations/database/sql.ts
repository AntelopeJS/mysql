import type { Dialect } from "../../dialect";
import type { Conversion } from "../../dialect/external";
import type { ConstantJson } from "../../dialect/sql-types";
import type { KeyColumn } from "./paths";
import { BOOL, FLOAT, type SqlType, TEXT, TIMESTAMP } from "./types";
import { type Sql, ident, sql } from "../../statement";

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
}

/**
 * Where a value read from a table's row comes from: a physical column and the JSON path below it.
 * Carried while the value is still that read, so a read that lands on what a key column holds can
 * name the key column instead. `keys` are the table's key columns at the row's alias, present only
 * where the row is the table itself and not a subselect that left them out. `elements` are the
 * columns a multi-valued index is built over.
 */
export interface ValuePath {
  readonly alias: string;
  readonly keys: readonly KeyColumn[];
  readonly elements: readonly string[];
  readonly source: string;
  readonly path: readonly string[];
}

export interface Compiled {
  sql: Sql;
  type: SqlType;
  /** The key column holding this value, where a declared index keys on it. */
  key?: KeyReference;
  /** The row column and JSON path this value reads, while it is still exactly that read. */
  path?: ValuePath;
  /**
   * The row column and JSON path a default stands in for: this value is that read on every row
   * where the read is present, and the default elsewhere.
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
 * column's native type: two operands of one type compare bare.
 */
export interface NativeOperand {
  readonly sql: Sql;
  readonly order: readonly Sql[];
  readonly bind: Conversion;
  readonly numeric: boolean;
  readonly type: string;
}

/** References a column of an aliased relation; the single spelling every compiled fragment uses. */
export function QualifiedColumn(alias: string, column: string): Sql {
  return sql`${ident(alias)}.${ident(column)}`;
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
