import assert from "node:assert";

import type { Dialect } from "../../dialect";
import { type Sql, sql } from "../../statement";
import type { KeyColumn } from "./paths";
import type { SqlType } from "./types";
import {
  type Compiled,
  type KeyReference,
  QualifiedColumn,
  type ValuePath,
} from "./sql";

type KeyRead = KeyColumn["read"];

/** The key column read a value read out of JSON as each scalar kind lands on. */
const MEMBER_KEY_READS: Partial<Record<SqlType["kind"], KeyRead>> = {
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
  return best && { column: QualifiedColumn(alias, best.name), key: best };
}

/**
 * The one choke point between a value read out of a table's JSON and the key columns that hold it.
 *
 * A read of the value at a path as text, a number or a boolean is exactly what a key column of that
 * read holds, so the read names the column beside its own SQL and a comparison can be served by the
 * column's index. The engine's own recognition of a generated column's expression is not relied
 * on: MySQL does it only for some spellings, and MariaDB not at all.
 */
export function PathReference(
  path: ValuePath | undefined,
  target: SqlType,
): KeyReference | undefined {
  const read = MEMBER_KEY_READS[target.kind];
  if (!path || !read) {
    return undefined;
  }
  return KeyAt(path.alias, path.keys, path.source, path.path, read);
}

/**
 * Whether a JSON array holds the element. A column a multi-valued index is built over is named
 * through the index's own expression, which is what lets the server serve the test from the index;
 * any other array is named as it is.
 */
export function Contains(dialect: Dialect, array: Compiled, element: Sql): Sql {
  const path = array.path;
  const isIndexed =
    path !== undefined &&
    path.path.length === 0 &&
    path.elements.includes(path.source);
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

function KeyedBound(
  dialect: Dialect,
  key: KeyReference,
  other: Compiled,
  operator: Ordering,
): Sql {
  const fit = "fit" in key.key ? key.key.fit : undefined;
  if (fit?.kind !== "prefix") {
    return sql`${key.column} ${OPERATORS[operator]} ${other.sql}`;
  }
  const bound = dialect.sql.scalar.left(other.sql, fit.width);
  return sql`${key.column} ${OPERATORS[PREFIX_BOUNDS[operator]]} ${bound}`;
}

/**
 * Compares two operands already at their common type, through a key column where one holds an
 * operand.
 *
 * The key column's bound narrows the rows through its index, and the comparison of the values
 * themselves decides them: a prefix key holds a value's first characters only, and a test of the
 * value itself is cheap on the rows the index already chose. So an index never changes which rows
 * match, only how fast they are found.
 */
export function Compare(
  dialect: Dialect,
  left: Compiled,
  right: Compiled,
  operator: Ordering,
): Sql {
  const plain = sql`${left.sql} ${OPERATORS[operator]} ${right.sql}`;
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
 * The key column an equality on `value` can be served by, and `other` fitted to what it holds: the
 * form a list of keys takes, where {@link Compare} takes one pair at a time.
 */
export function EqualityKey(
  dialect: Dialect,
  value: Compiled,
  other: Sql,
): { readonly column: Sql; readonly bound: Sql } | undefined {
  if (!value.key) {
    return undefined;
  }
  const key = value.key;
  const fit = "fit" in key.key ? key.key.fit : undefined;
  const bound =
    fit?.kind === "prefix" ? dialect.sql.scalar.left(other, fit.width) : other;
  return { column: key.column, bound };
}

/**
 * Aggregates rows into a JSON array in a stated order, empty rather than NULL over none of them.
 *
 * The order is named explicitly where it matters, and `distinct` dedups the elements. The two are
 * exclusive: nothing asks for both, and an engine may refuse ordering a deduplicated aggregate by
 * anything but its argument.
 */
export function Collected(
  dialect: Dialect,
  order: Sql | undefined,
  target: Sql,
  distinct = false,
): Sql {
  assert(
    !distinct || order === undefined,
    "A collected aggregate orders its elements or dedups them, never both",
  );
  return dialect.sql.json.collect(target, order, distinct);
}
