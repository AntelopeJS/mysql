import type { Dialect } from "../../dialect";
import { sql } from "../../statement";
import type { Compiled } from "./sql";
import { PathReference } from "./json";
import {
  ArrayOf,
  IsJsonBacked,
  IsOpaque,
  JsonOf,
  OPAQUE,
  KeyTypesOf,
  type KeyTypes,
  type SqlType,
} from "./types";

export interface CompiledPair {
  left: Compiled;
  right: Compiled;
  type: SqlType;
}

/**
 * Common type for two operands of the same operator.
 *
 * The bottom type is pulled *toward* the concrete operand, which is what lets a JSON path be
 * compared against a known type rather than as text. Bottom is therefore not absorbing — use
 * {@link UnifyAll} to join a collection of element types, where it must be.
 */
export function Unify(left: SqlType, right: SqlType): SqlType {
  if (IsOpaque(left)) {
    return right;
  }
  if (IsOpaque(right)) {
    return left;
  }
  if (left.kind === right.kind) {
    return UnifySameKind(left, right);
  }
  return OPAQUE;
}

function UnifySameKind(left: SqlType, right: SqlType): SqlType {
  if (left.kind === "array" && right.kind === "array") {
    return ArrayOf(Unify(left.elem, right.elem));
  }
  if (left.kind === "json" && right.kind === "json") {
    return JsonOf(UnifyKeyTypes(left.keys, right.keys));
  }
  return left;
}

function UnifyKeyTypes(
  left?: KeyTypes,
  right?: KeyTypes,
): KeyTypes | undefined {
  if (!left || !right) {
    return undefined;
  }
  const keyTypes: Record<string, SqlType> = {};
  for (const [name, type] of Object.entries(left)) {
    if (Object.hasOwn(right, name)) {
      keyTypes[name] = Unify(type, right[name]);
    }
  }
  return Object.keys(keyTypes).length > 0 ? keyTypes : undefined;
}

/**
 * Common type for values that arrive from *alternative* sources, such as the two halves of a
 * union.
 *
 * Where {@link Unify} intersects two JSON shapes, this takes their union, because every row comes
 * from exactly one side and carries that side's keys. Anything else — two scalars, two arrays, a
 * shaped side against an unshaped one — is {@link Unify}.
 */
export function Widen(left: SqlType, right: SqlType): SqlType {
  const leftKeys = KeyTypesOf(left);
  const rightKeys = KeyTypesOf(right);
  if (!leftKeys || !rightKeys) {
    return Unify(left, right);
  }
  const keyTypes = { ...leftKeys };
  for (const [name, type] of Object.entries(rightKeys)) {
    keyTypes[name] = Object.hasOwn(leftKeys, name)
      ? Unify(leftKeys[name], type)
      : type;
  }
  return JsonOf(keyTypes);
}

/**
 * Rewrites a value as the target type.
 *
 * Reading *out* of JSON is guarded by the value's JSON kind, so a key whose stored values are
 * heterogeneous yields NULL for the ones that do not fit rather than a converted value: the contract
 * compares values of different types as unequal, and a total conversion would make `eq("42")` match
 * a stored number. A read that lands on what a key column holds carries that key column.
 *
 * The value keeps its key and path where the SQL is unchanged, since it is then still that read.
 */
export function Cast(
  dialect: Dialect,
  value: Compiled,
  target: SqlType,
): Compiled {
  const type = value.type;
  if (type.kind === target.kind) {
    return { ...value, type: target };
  }
  if (IsJsonBacked(type) && IsJsonBacked(target)) {
    return { ...value, type: target };
  }
  if (IsJsonBacked(target)) {
    if (IsJsonBacked(type)) {
      return { sql: value.sql, type: OPAQUE };
    }
    return { sql: dialect.sql.json.of(value.sql, type.kind), type: OPAQUE };
  }
  if (IsJsonBacked(type)) {
    return {
      sql: dialect.sql.json.as(value.sql, target.kind),
      type: target,
      key: PathReference(value.path, target),
    };
  }
  return { sql: dialect.sql.scalar.cast(value.sql, target.kind), type: target };
}

/**
 * Element type for a collection, where the bottom type is absorbing.
 *
 * {@link Unify} alone is not associative, so folding it over three or more element types can
 * re-promote a mixed collection back to a concrete type.
 */
export function UnifyAll(types: SqlType[]): SqlType {
  if (types.length === 0) {
    return OPAQUE;
  }
  return types.reduce((left, right) =>
    IsOpaque(left) || IsOpaque(right) ? OPAQUE : Unify(left, right),
  );
}

/** The two operands of a comparison at their common type. */
export function UnifyOperands(
  dialect: Dialect,
  left: Compiled,
  right: Compiled,
): CompiledPair {
  const type = Unify(left.type, right.type);
  return {
    left: Cast(dialect, left, type),
    right: Cast(dialect, right, type),
    type,
  };
}

/**
 * The absence a default answers, which a JSON-backed operand spells two ways.
 * A stored JSON null is a value rather than SQL NULL, so `COALESCE` alone never fires.
 */
function Absent(dialect: Dialect, pair: CompiledPair) {
  if (!IsJsonBacked(pair.type)) {
    return pair.left.sql;
  }
  return sql`NULLIF(${pair.left.sql}, ${dialect.sql.json.null})`;
}

/**
 * Common type for a value and the default standing in for its absence.
 * Not {@link Unify}: a JSON-backed value keeps its kind and the default is lifted to JSON.
 */
function DefaultType(value: SqlType, def: SqlType): SqlType {
  if (IsJsonBacked(value) && value.kind !== def.kind) {
    return OPAQUE;
  }
  return Unify(value, def);
}

export function WithDefault(
  dialect: Dialect,
  value: Compiled,
  def?: Compiled,
): Compiled {
  if (!def) {
    return value;
  }
  const type = DefaultType(value.type, def.type);
  const pair: CompiledPair = {
    left: Cast(dialect, value, type),
    right: Cast(dialect, def, type),
    type,
  };
  return {
    sql: sql`COALESCE(${Absent(dialect, pair)}, ${pair.right.sql})`,
    type: pair.type,
  };
}
