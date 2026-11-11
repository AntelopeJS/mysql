export interface KeyTypes {
  readonly [field: string]: SqlType;
}

export interface TextType {
  readonly kind: "text";
}
export interface FloatType {
  readonly kind: "float";
}
export interface BoolType {
  readonly kind: "bool";
}
export interface TimestampType {
  readonly kind: "timestamp";
}
export interface ArrayType {
  readonly kind: "array";
  readonly elem: SqlType;
}
export interface JsonType {
  readonly kind: "json";
  readonly keys?: KeyTypes;
}

/**
 * The compiler's own type lattice. The dialect maps each kind to a physical column type; nothing
 * else reads a physical type.
 */
export type SqlType =
  | TextType
  | FloatType
  | BoolType
  | TimestampType
  | ArrayType
  | JsonType;

export const TEXT: TextType = { kind: "text" };
export const FLOAT: FloatType = { kind: "float" };
export const BOOL: BoolType = { kind: "bool" };
export const TIMESTAMP: TimestampType = { kind: "timestamp" };
export const OPAQUE: JsonType = { kind: "json" };

export function ArrayOf(elem: SqlType): ArrayType {
  return { kind: "array", elem };
}

/**
 * A shape that is *empty* is not a shape that is *unknown*: the first declares no members, the
 * second declares nothing about them. Only the second is {@link OPAQUE} — conflating them makes
 * `merge({})` erase what the left side declared, and a declared date then reads back as text.
 */
export function JsonOf(keyTypes?: KeyTypes): JsonType {
  if (!keyTypes) {
    return OPAQUE;
  }
  return { kind: "json", keys: keyTypes };
}

export function IsOpaque(type: SqlType): boolean {
  return type.kind === "json" && !type.keys;
}

/** Whether values of the type are stored as JSON: a declared object, `any`, a nested shape or a list. */
export function IsJsonBacked(type: SqlType): type is ArrayType | JsonType {
  return type.kind === "json" || type.kind === "array";
}

/**
 * Whether a declared type holds a *list* of values rather than one.
 *
 * The one test `getAll`, `lookup` and `between` ask of a column, and the one a `multi` index asks to
 * choose a multi-valued index over a btree, so the index and the comparisons it serves cannot stop
 * agreeing on which columns hold lists.
 */
export function IsArray(type: SqlType): type is ArrayType {
  return type.kind === "array";
}

/** The declared members of a json type, or nothing for any type whose members are unknown. */
export function KeyTypesOf(type: SqlType): KeyTypes | undefined {
  return type.kind === "json" ? type.keys : undefined;
}
