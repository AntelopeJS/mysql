import type { Dialect } from "../../dialect";
import type { ConstantJson } from "../../dialect/sql-types";
import type { KeyColumn } from "./paths";
import { BOOL, FLOAT, type SqlType, TEXT, TIMESTAMP } from "./types";
import { type Sql, ident, sql } from "../../statement";

export type { ConstantJson } from "../../dialect/sql-types";

/**
 * A key column that holds the value a {@link Compiled} reads, as a comparison can use it: by name,
 * at the alias of the row it belongs to. A `prefix` key holds the value's first `width`
 * characters, so a comparison served by it also tests the value itself.
 */
export interface KeyReference {
  readonly column: Sql;
  readonly key: KeyColumn;
}

/**
 * Where a value read from a table's row comes from: a physical column and the JSON path below it.
 * Carried while the value is still that read, so a read that lands on what a key column holds can
 * name the key column instead. `keys` are the table's key columns at the row's alias, present only
 * where the row is the table itself and not a subselect that left them out.
 */
export interface ValuePath {
  readonly alias: string;
  readonly keys: readonly KeyColumn[];
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
