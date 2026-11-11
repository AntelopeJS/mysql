import type { Sql } from "../statement";
import type { KeyColumn } from "../implementations/database/paths";
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

/** What a walk iterates: a list's elements, an object's keys, or an object's member values. */
export type WalkKind = "elements" | "keys" | "members";

/**
 * Rows over a container's contents, in the container's own order, for a scalar subquery that
 * aggregates them. A non-container yields no row; a JSON null element reads as SQL NULL.
 */
export interface Walk {
  /** The 1-based place of a row in the container's order. */
  readonly ordinal: Sql;
  /** An element, a key as a JSON string, or a member's value. */
  readonly value: Sql;
  /** The scalar subquery that evaluates `select` over the rows `where` keeps, or over all of them. */
  aggregate(select: Sql, where?: Sql): Sql;
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
  /**
   * What a key column of `read` holds for the value read out of its source, before it is cut to its
   * width. The column's generation expression and the compiler's read of the same value are this
   * member, so an index serves what a statement reads.
   */
  key(read: KeyColumn["read"], value: Sql): Sql;
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
  /**
   * The array a column's multi-valued index is built on. A test that names the column through it,
   * as `includes` does, is served by the index; one that names the bare column is not.
   */
  indexedElements(column: Sql): Sql;
  /** Whether a value is truthy in JavaScript's sense; SQL NULL stays SQL NULL. */
  truthy(value: Sql): Sql;
  /**
   * Aggregates JSON elements into an array, empty rather than SQL NULL over no row, in `order` or
   * deduplicated, never both.
   */
  collect(element: Sql, order: Sql | undefined, distinct: boolean): Sql;
  /** The number of elements of an array, or of members of an object. */
  length(container: Sql): Sql;
  /**
   * The element at a 0-based position of an array, counted from the end when negative; SQL NULL
   * beyond either end. The position is a number, truncated and clamped to the range an array can
   * hold. Only an array is meant to reach it.
   */
  at(array: Sql, position: Sql): Sql;
  /** An array followed by the elements of another, or by a single value; a non-array is left to the engine. */
  concatArrays(left: Sql, right: Sql): Sql;
  /**
   * Two objects merged one level deep, the right's members winning and any null kept. SQL NULL
   * where either is not an object. `alias` names the derived tables the merge holds each side in,
   * so it spells each operand once however many merges are chained.
   */
  shallowMerge(left: Sql, right: Sql, alias: string): Sql;
  /**
   * Text split at every occurrence of a non-empty separator into a JSON array of texts, the first
   * `limit` of them when given; SQL NULL for SQL NULL. An empty text is one empty piece, as in
   * JavaScript. `alias` names the derived tables, as for {@link JsonSyntax.shallowMerge}.
   */
  split(
    text: Sql,
    separator: string,
    limit: number | undefined,
    alias: string,
  ): Sql;
  /** The rows over a container's contents; `alias` names them. */
  walk(kind: WalkKind, source: Sql, alias: string): Walk;
}

/**
 * Integer arithmetic as JavaScript's bitwise operators do it. Every operand and every result is an
 * integer read through {@link Int32Syntax.read}; none of them ever fails the statement.
 */
export interface Int32Syntax {
  /** A number as `ToInt32` reads it: truncated, wrapped modulo 2^32 and signed. SQL NULL stays SQL NULL. */
  read(value: Sql): Sql;
  and(left: Sql, right: Sql): Sql;
  or(left: Sql, right: Sql): Sql;
  xor(left: Sql, right: Sql): Sql;
  not(value: Sql): Sql;
  /** `value << count`, the count taken modulo 32. */
  shiftLeft(value: Sql, count: Sql): Sql;
  /** `value >> count`, which keeps the sign. */
  shiftRight(value: Sql, count: Sql): Sql;
  /** `value >>> count`, which fills with zeros: the unsigned 32-bit result. */
  shiftRightUnsigned(value: Sql, count: Sql): Sql;
}

/** Regular expressions, in the flavour of the engine and written in JavaScript's. */
export interface RegexSyntax {
  /**
   * A JavaScript pattern rewritten for the engine, where the two flavours disagree on what `.`,
   * `$` and a nested class mean.
   */
  translate(pattern: string): string;
  /** Whether text matches a pattern, case-sensitively; SQL NULL where either is. */
  matches(text: Sql, pattern: Sql): Sql;
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
  readonly int32: Int32Syntax;
  readonly regex: RegexSyntax;
}

/** The calendar and clock readings of an instant. */
export type TimePart =
  | "year"
  | "month"
  | "day"
  | "weekday"
  | "dayOfYear"
  | "hour"
  | "minute"
  | "second"
  | "timeOfDay";

/** Instants: stored in UTC, read and written in JavaScript's spellings. */
export interface TimeSyntax {
  /**
   * A reading of an instant as a number: the weekday runs from Monday 1 to Sunday 7, and `second`
   * and `timeOfDay` (in seconds since midnight) carry the fraction.
   */
  part(moment: Sql, part: TimePart): Sql;
  /** The wall-clock reading of an instant in a named or offset zone; SQL NULL for a zone the engine does not know. */
  inZone(moment: Sql, zone: Sql): Sql;
  /** An instant as `Date.prototype.toISOString` spells it. */
  isoText(value: Sql): Sql;
  /** An instant as epoch milliseconds. */
  toEpochMs(value: Sql): Sql;
  /** Epoch milliseconds as an instant; SQL NULL outside the range an instant can hold. */
  fromEpochMs(value: Sql): Sql;
  /** Text read as an instant where it spells an ISO 8601 date or date-time, SQL NULL otherwise. */
  parseText(text: Sql): Sql;
}

/**
 * A correlated subselect brought into the statement that reads it: the join clause that brings it
 * in, absent where the engine reads it inline instead, and how the row reads its one column.
 */
interface CorrelatedRead {
  readonly join?: Sql;
  readonly value: Sql;
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
  /**
   * Brings in a subselect that answers at most one row, correlated to the row it is read for, at
   * `alias`; `column` is the one column it selects. A row it answers nothing for reads SQL NULL.
   */
  lookup(subselect: Sql, alias: string, column: string): CorrelatedRead;
}

/** The expression members the compiler and the writes reach. */
export interface CompilerSyntax {
  readonly json: JsonSyntax;
  readonly scalar: ScalarSyntax;
  readonly time: TimeSyntax;
  readonly rows: RowSyntax;
}
