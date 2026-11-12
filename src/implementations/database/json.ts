import assert from "node:assert";

import type { Dialect } from "../../dialect";
import { type Sql, join, sql } from "../../statement";
import type { KeyColumn } from "./paths";
import { IsJsonBacked, type SqlType } from "./types";
import { ValueKeyAt, ValueKeyRead } from "./value-key";
import {
  type Compiled,
  Equal,
  type Equality,
  type KeyReference,
  QualifiedColumn,
  type ValuePath,
} from "./sql";

type KeyRead = KeyColumn["read"];

/** The key column read a value read out of JSON as each scalar kind lands on. */
const MEMBER_KEY_READS: Partial<
  Record<SqlType["kind"], Extract<KeyRead, "string" | "double" | "bool">>
> = {
  text: "string",
  float: "double",
  bool: "bool",
};

function SamePath(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}

/** An exact key holds the whole value, so it is preferred; among prefixes the widest is. */
function KeyRank(key: KeyColumn): number {
  if (!("fit" in key)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return key.fit.kind === "exact" ? Number.MAX_SAFE_INTEGER : key.fit.width;
}

/** The key column at a row's alias that holds `read` of `source` at `path`, if a declared index made one. */
export function KeyAt(
  alias: string,
  keys: readonly KeyColumn[],
  source: string,
  path: readonly string[],
  read: KeyRead,
): KeyReference | undefined {
  const matches = keys.filter(
    (key) =>
      key.source === source && key.read === read && SamePath(key.path, path),
  );
  const best = matches.sort((left, right) => KeyRank(right) - KeyRank(left))[0];
  return best && TypedKeyReference(alias, best);
}

/** A key column of a typed read at a row's alias, which holds the value on every row and NULL where it is absent. */
export function TypedKeyReference(alias: string, key: KeyColumn): KeyReference {
  const column = QualifiedColumn(alias, key.name);
  return {
    column,
    key,
    rows: "every",
    pins: [],
    absent: sql`${column} IS NULL`,
  };
}

/**
 * The key column of a typed read at a path: one keyed by that read where the declaration types the
 * path, or else the value key over it, which holds a value of every kind.
 */
function KeyOfPath(
  dialect: Dialect,
  path: ValuePath,
  read: Extract<KeyRead, "string" | "double" | "bool">,
): KeyReference | undefined {
  const column = path.column;
  if (!column) {
    return undefined;
  }
  const typed = KeyAt(
    column.alias,
    column.keys,
    column.source,
    path.path,
    read,
  );
  if (typed) {
    return typed;
  }
  const value = ValueKeyAt(
    column.alias,
    column.values,
    column.source,
    path.path,
  );
  return value && ValueKeyRead(dialect, value, read);
}

/**
 * The one choke point between a value read out of a table's JSON and the key columns that hold it.
 *
 * A read of the value at a path as text, a number or a boolean is exactly what a key column of that
 * read holds, so the read names the column beside its own SQL and a comparison can be served by the
 * column's index. The engine's own recognition of a generated column's expression is not relied
 * on: MySQL does it only for some spellings, and MariaDB not at all. A value that falls back from
 * such a read to a default names the column too, as holding it only where it is set.
 */
export function PathReference(
  dialect: Dialect,
  value: Pick<Compiled, "path" | "defaulted">,
  target: SqlType,
): KeyReference | undefined {
  const read = MEMBER_KEY_READS[target.kind];
  if (!read) {
    return undefined;
  }
  if (value.path) {
    return KeyOfPath(dialect, value.path, read);
  }
  const fallback = value.defaulted && KeyOfPath(dialect, value.defaulted, read);
  return fallback && { ...fallback, rows: "set" };
}

/**
 * Whether a JSON array holds the element. A column a multi-valued index is built over is named
 * through the index's own expression, which is what lets the server serve the test from the index;
 * any other array is named as it is.
 */
export function Contains(dialect: Dialect, array: Compiled, element: Sql): Sql {
  const path = array.path;
  const column = path?.column;
  const isIndexed =
    path !== undefined &&
    column !== undefined &&
    path.path.length === 0 &&
    column.elements.includes(column.source);
  const operand = isIndexed
    ? dialect.sql.json.indexedElements(array.sql)
    : array.sql;
  return dialect.sql.json.includes(operand, element);
}

/** The comparisons a key column can serve, in the operand order they are written. */
export type Ordering = "=" | "<" | "<=" | ">" | ">=";

const OPERATORS: Record<Ordering, Sql> = {
  "=": sql`=`,
  "<": sql`<`,
  "<=": sql`<=`,
  ">": sql`>`,
  ">=": sql`>=`,
};

/** The operator a prefix key is compared by, which must not exclude a value its prefix ties with. */
const PREFIX_BOUNDS: Record<Ordering, Ordering> = {
  "=": "=",
  "<": "<=",
  "<=": "<=",
  ">": ">=",
  ">=": ">=",
};

/** The operator as seen from the other operand, for a key on the right. */
const MIRRORED: Record<Ordering, Ordering> = {
  "=": "=",
  "<": ">",
  "<=": ">=",
  ">": "<",
  ">=": "<=",
};

/** The operand as a key column holds it: tagged as the column tags its kind, and cut to a prefix's width. */
function Held(dialect: Dialect, key: KeyReference, other: Sql): Sql {
  const tagged =
    key.tag === undefined ? other : dialect.sql.json.tagged(key.tag, other);
  const fit = "fit" in key.key ? key.key.fit : undefined;
  return fit?.kind === "prefix"
    ? dialect.sql.scalar.left(tagged, fit.width)
    : tagged;
}

/**
 * The other end of a tagged column's region for an ordering: values of one kind lie between its
 * tag and the next rank's, so a bound on one side of the operand is closed on the other by them.
 */
function TagRegion(
  dialect: Dialect,
  key: KeyReference,
  operator: Ordering,
): Sql | undefined {
  if (key.tag === undefined || operator === "=") {
    return undefined;
  }
  const json = dialect.sql.json;
  return operator === "<" || operator === "<="
    ? sql`${key.column} >= ${json.tagged(key.tag)}`
    : sql`${key.column} < ${json.tagged(key.tag + 1)}`;
}

function KeyedBound(
  dialect: Dialect,
  key: KeyReference,
  other: Compiled,
  operator: Ordering,
): Sql {
  const fit = "fit" in key.key ? key.key.fit : undefined;
  const compare = fit?.kind === "prefix" ? PREFIX_BOUNDS[operator] : operator;
  const compared = sql`${key.column} ${OPERATORS[compare]} ${Held(dialect, key, other.sql)}`;
  const region = TagRegion(dialect, key, operator);
  const parts = [
    ...(key.pins.length > 0 ? [Equal(key.pins)] : []),
    ...(region ? [region] : []),
    compared,
  ];
  const bound =
    parts.length === 1 ? compared : sql`(${join(parts, sql` AND `)})`;
  return key.rows === "set" ? sql`(${bound} OR ${key.absent})` : bound;
}

/**
 * Compares two operands already at their common type, through a key column where one holds an
 * operand.
 *
 * The key column's bound narrows the rows through its index, and the comparison of the values
 * themselves decides them: a prefix key holds a value's first characters only, a key `set` only
 * on some rows leaves the others to its NULL entries, and a test of the value itself is cheap on
 * the rows the index already chose. So an index never changes which rows match, only how fast they
 * are found.
 */
/** The terms a value sorts by: a JSON value in the order JSON values compare in. */
export function SortTerms(dialect: Dialect, value: Compiled): readonly Sql[] {
  return IsJsonBacked(value.type)
    ? dialect.sql.json.order(value.sql)
    : [value.sql];
}

/** Two operands of one type compared, as JSON where both are JSON values. */
export function Compared(
  dialect: Dialect,
  left: Compiled,
  right: Compiled,
  operator: Ordering,
): Sql {
  return IsJsonBacked(left.type) && IsJsonBacked(right.type)
    ? dialect.sql.json.compare(left.sql, right.sql, operator)
    : sql`${left.sql} ${OPERATORS[operator]} ${right.sql}`;
}

export function Compare(
  dialect: Dialect,
  left: Compiled,
  right: Compiled,
  operator: Ordering,
): Sql {
  const plain = Compared(dialect, left, right, operator);
  if (left.key) {
    return sql`(${KeyedBound(dialect, left.key, right, operator)} AND ${plain})`;
  }
  if (right.key) {
    const mirrored = MIRRORED[operator];
    return sql`(${KeyedBound(dialect, right.key, left, mirrored)} AND ${plain})`;
  }
  return sql`(${plain})`;
}

/**
 * The key columns an equality on `value` can be served by, and `other` fitted to what they hold: the
 * form a list of keys takes, where {@link Compare} takes one pair at a time. A key `set` only on
 * some rows cannot stand for the value in a list, so it serves none.
 */
export function EqualityKey(
  dialect: Dialect,
  value: Compiled,
  other: Sql,
): Equality[] | undefined {
  if (!value.key || value.key.rows === "set") {
    return undefined;
  }
  const key = value.key;
  return [
    ...key.pins,
    { column: key.column, value: Held(dialect, key, other) },
  ];
}

/**
 * Aggregates rows into a JSON array, empty rather than NULL over none of them.
 *
 * Where the order matters it is named by `ordinal`, a distinct positive integer per row, such as a
 * walk's position or a row number, and `distinct` dedups the elements. The two are exclusive:
 * nothing asks for both.
 */
export function Collected(
  dialect: Dialect,
  ordinal: Sql | undefined,
  target: Sql,
  distinct = false,
): Sql {
  assert(
    !distinct || ordinal === undefined,
    "A collected aggregate orders its elements or dedups them, never both",
  );
  return dialect.sql.json.collect(target, ordinal, distinct);
}
