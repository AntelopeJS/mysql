import type { Sql } from "../statement";
import type { SqlType } from "../implementations/database/types";

/** The kinds of JSON value, in one vocabulary whatever names the engine gives them. */
export type JsonKind =
  | "object"
  | "array"
  | "string"
  | "number"
  | "boolean"
  | "null";

/** The kinds a scalar SQL value can be read as. */
export type ScalarKind = Exclude<SqlType["kind"], "json" | "array">;

/** JSON a statement can bind whole. */
export type ConstantJson =
  | null
  | string
  | number
  | boolean
  | ConstantJson[]
  | { [key: string]: ConstantJson | undefined };

/**
 * Bound values, typed in the statement: the driver sends an integer and a fraction as different
 * types and a boolean as an integer, so each kind is bound through its own member.
 */
export interface BindSyntax {
  text(value: string): Sql;
  float(value: number): Sql;
  bool(value: boolean): Sql;
  /** An instant; an invalid date binds SQL NULL. */
  timestamp(value: Date): Sql;
  /** A JSON document sent whole as its text. */
  json(value: ConstantJson): Sql;
}

/** One member of a document assembled from columns. `container` marks a JSON-backed member. */
export interface DocumentMember {
  readonly name: string;
  readonly value: Sql;
  readonly container: boolean;
}

/**
 * JSON access and construction. Every value going in and coming out is a JSON value except where a
 * member says it reads or takes a scalar; SQL NULL stays SQL NULL throughout.
 */
export interface JsonSyntax {
  /** The value under a static key of a document; SQL NULL when absent or not an object. */
  member(document: Sql, key: string): Sql;
  /** The value under a key the statement computes as text. */
  dynamicMember(document: Sql, key: Sql): Sql;
  /** Whether a value is of the kind: SQL NULL for SQL NULL, and never an error. */
  is(value: Sql, kinds: readonly JsonKind[]): Sql;
  /** A value read as a scalar of `kind`; SQL NULL where it holds another kind. */
  as(value: Sql, kind: ScalarKind): Sql;
  /** A scalar of `kind` as a JSON value. */
  of(value: Sql, kind: ScalarKind): Sql;
  /** JSON text, parsed. */
  parse(text: Sql): Sql;
  /** The canonical text of a value, which two equal values share. */
  text(value: Sql): Sql;
  /** The JSON `null`, which is a value and not SQL NULL. */
  readonly null: Sql;
  readonly emptyObject: Sql;
  readonly emptyArray: Sql;
  object(entries: readonly (readonly [string, Sql])[]): Sql;
  array(items: readonly Sql[]): Sql;
  /**
   * A document of named members: a member that is SQL NULL is absent, a JSON-backed member keeps
   * any null inside it, and `overflow`'s keys are merged in beside the members, which win.
   */
  document(members: readonly DocumentMember[], overflow?: Sql): Sql;
  /** The document with the keys removed; a key it does not hold is ignored. */
  removeKeys(document: Sql, keys: readonly string[]): Sql;
  /** The document with each key set to its JSON value, added where absent. */
  setKeys(document: Sql, entries: readonly (readonly [string, Sql])[]): Sql;
  /** Whether a document holds the key, whatever its value. */
  hasKey(document: Sql, key: string): Sql;
  /** Whether a JSON array holds the scalar or JSON element, as an index over its elements serves. */
  includes(array: Sql, element: Sql): Sql;
  /** Whether a value is truthy in JavaScript's sense; SQL NULL stays SQL NULL. */
  truthy(value: Sql): Sql;
  /**
   * Aggregates JSON elements into an array, empty rather than SQL NULL over no row, in `order` or
   * deduplicated, never both.
   */
  collect(element: Sql, order: Sql | undefined, distinct: boolean): Sql;
}

/** Text and number readings an engine spells its own way. */
export interface ScalarSyntax {
  /** A scalar converted to `kind`, as the engine's own cast does. */
  cast(value: Sql, kind: ScalarKind): Sql;
  readonly bind: BindSyntax;
  /** Text read as a number where it spells a decimal literal, SQL NULL otherwise. */
  parseNumber(text: Sql): Sql;
  /** A number truncated toward zero. */
  truncate(value: Sql): Sql;
  /** Concatenated text; never an operator that reads as a boolean. */
  concat(parts: readonly Sql[]): Sql;
  /** The first `width` characters of a text. */
  left(text: Sql, width: number): Sql;
}

/** Instants: stored in UTC, read and written in JavaScript's spellings. */
export interface TimeSyntax {
  /** An instant as `Date.prototype.toISOString` spells it. */
  isoText(value: Sql): Sql;
  /** An instant as epoch milliseconds. */
  toEpochMs(value: Sql): Sql;
  /** Epoch milliseconds as an instant; SQL NULL outside the range an instant can hold. */
  fromEpochMs(value: Sql): Sql;
  /** Text read as an instant where it spells an ISO 8601 date or date-time, SQL NULL otherwise. */
  parseText(text: Sql): Sql;
}

/** Row-level constructs that differ between engines in algorithm, not only in spelling. */
export interface RowSyntax {
  /** Equality that holds between two SQL NULLs. */
  nullSafeEqual(left: Sql, right: Sql): Sql;
  /**
   * The clause bounding a result to `count` rows after skipping `offset`, either of them absent;
   * nothing when both are. The counts are bound, so one statement serves every page.
   */
  limit(count: number | undefined, offset: number | undefined): Sql | undefined;
  /**
   * The hint that keeps a derived table from being merged into a statement that writes the table
   * the derived table reads. It goes right after the statement's verb.
   */
  materialize(alias: string): Sql;
}

/** The expression members the compiler and the writes reach. */
export interface CompilerSyntax {
  readonly json: JsonSyntax;
  readonly scalar: ScalarSyntax;
  readonly time: TimeSyntax;
  readonly rows: RowSyntax;
}
