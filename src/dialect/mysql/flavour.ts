import { type Sql, ident, int, join, lit, sql } from "../../statement";
import type { ExternalCatalogSyntax } from "../external";
import type { JsonSyntax, KeyedJoinSyntax } from "../sql-types";

/** A value a one-row table holds, which the row reads back as a JSON value or as text. */
export interface Held {
  readonly name: string;
  readonly value: Sql;
  /**
   * `json` reads back a JSON value and `text` reads back text. `jsonText` reads back a JSON value
   * that the hold carries as its JSON text, so it adds no level of nesting around it.
   */
  readonly kind: "json" | "jsonText" | "text";
}

/** A member of a JSON document named by the keys of its path. */
export interface MemberPath {
  readonly document: Sql;
  /** The keys from the document to the object that holds the member; none where the document does. */
  readonly holder: readonly string[];
  /** The member's own key. */
  readonly key: string;
}

/**
 * How an engine whose JSON paths match a key only as the document spells it reads a member stored
 * under another spelling of its key, as `"caf\u00e9"` spells `café`.
 */
export interface EscapedKeys {
  /** The member, where `read` of a document, the read by the path's own spelling, is SQL NULL. */
  member(member: MemberPath, read: (document: Sql) => Sql): Sql;
  /** Whether the document holds the member, where `found` of a document, the test by the path's own spelling, is false. */
  has(member: MemberPath, found: (document: Sql) => Sql): Sql;
  /** The member under a key the statement computes as text, whose path as the key is spelled is `path` of the key. */
  computed(document: Sql, key: Sql, path: (key: Sql) => Sql): Sql;
}

/**
 * What MySQL and MariaDB spell differently. Every other statement this directory writes is the same
 * on both, so each of its modules is a function of one flavour, and an engine of the family is one
 * flavour.
 */
export interface Flavour {
  /** The engine's name, as `SELECT VERSION()` tells it and external mode's catalog reports it. */
  readonly id: "mysql" | "mariadb";
  /** The engine's name as a person reads it, in the module's log. */
  readonly name: "MySQL" | "MariaDB";
  /** The binary, NO PAD collation of every text column, literal and bound parameter. */
  readonly binaryCollation: string;
  /** The column type of a JSON document, in the binary collation. */
  readonly jsonType: Sql;
  /** The most containers a stored JSON document nests. */
  readonly maxJsonNesting: number;
  /** The errno a statement fails with when a JSON document it reads or builds nests too deep. */
  readonly tooDeepErrno: number;
  /**
   * Whether a JSON document a statement reads too deep answers SQL NULL with a
   * {@link Flavour.tooDeepErrno} warning, rather than failing the statement.
   */
  readonly warnsTooDeep: boolean;
  /** The containers the engine's one-row hold nests a value in, as a poll reads each image. */
  readonly heldNesting: number;
  /** Whether a `multi` index over a JSON array can be built as a multi-valued index. */
  readonly multiValuedIndex: boolean;
  /** Session assignments of the engine's own that the pin adds to the family's. */
  readonly pinned: readonly Sql[];
  /** The session assignment that stops a read after `ms`, where 0 leaves reads unbounded. */
  readTimeout(ms: number): Sql;
  /** The statement, free of {@link Flavour.readTimeout} where it writes or changes a table. */
  uncapped(statement: Sql): Sql;
  /** The errnos a read stopped by {@link Flavour.readTimeout} answers. */
  readonly readTimeoutErrnos: readonly number[];
  /** The errno and message pattern of a violated `CHECK` constraint, the constraint's name its group. */
  readonly checkViolation: { readonly errno: number; readonly named: RegExp };
  /**
   * Whether two JSON values are equal as JSON, SQL NULL where either is; absent where `=`, `<=>` and
   * the orderings already compare two JSON values as JSON rather than as text.
   */
  readonly jsonEquals?: (left: Sql, right: Sql) => Sql;
  /** JSON text as a JSON value, one the JSON functions take whole rather than as a string. */
  json(text: Sql): Sql;
  /** Absent where the engine stores every key decoded, so a path finds a key however it was written. */
  readonly escapedKeys?: EscapedKeys;
  /**
   * Present where the engine stores an object as written, one key named twice included: the key
   * of each of its members in order, as a JSON array, for an object whose `JSON_DEPTH` is below
   * {@link Flavour.maxJsonNesting}. A deeper one may nest too deep once listed.
   */
  readonly memberKeys?: (object: Sql) => Sql;
  /** The JSON syntax's `present`, which depends on how the engine compares a JSON string. */
  present(value: Sql): Sql;
  /** The JSON syntax's `absent`, which depends on how the engine compares a JSON string. */
  absent(value: Sql): Sql;
  /**
   * `JSON_VALUE` of the path, whatever the length of the string it finds: a string's text, SQL
   * NULL for an absent value and a JSON null.
   */
  value(document: Sql, path: Sql): Sql;
  /**
   * Whether {@link Flavour.value} is SQL NULL exactly where a member read is absent or equal to a
   * JSON null, so a default's text is one `COALESCE`. MySQL's documents hold their keys decoded.
   * MariaDB's `JSON_VALUE` finds a plain key stored escaped, as `"f\u0072"`, that the member
   * read leaves unread.
   */
  readonly valueIsRead: boolean;
  /** A double as a JSON number, a negative zero included. */
  number(value: Sql): Sql;
  /**
   * The JSON syntax's `canonicalNumber`, which depends on how the engine stores a number and
   * whether its dedup compares a container as JSON or as text.
   */
  canonicalNumber(value: Sql): Sql;
  /** Whether JSON text the engine parses keeps a finite number exactly. */
  keepsInText(value: number): boolean;
  /** A comparison's truth as a JSON boolean; SQL NULL stays SQL NULL. */
  boolean(truth: Sql): Sql;
  /** Whether a JSON array holds an element, which a JSON value or a scalar can be. */
  includes(array: Sql, element: Sql): Sql;
  /** The JSON syntax's `collect`, which depends on the order the engine's aggregates keep. */
  collect(
    element: Sql,
    ordinal: Sql | undefined,
    distinct: boolean,
    textOf: (value: Sql) => Sql,
  ): Sql;
  /** The JSON syntax's `inPlace`, where a derived table reads no outer column. */
  readonly inPlace?: JsonSyntax["inPlace"];
  /** Whether an `INSERT` can answer values of the row it wrote, by a `RETURNING` clause. */
  readonly returning: boolean;
  /** Whether a derived table can read the columns of the tables joined before it. */
  readonly lateral: boolean;
  /** Whether a subquery inside a table function's argument can read a column of an outer query. */
  readonly outerInTableFunction: boolean;
  /**
   * Present where the engine joins on an equality no index serves by block nested loop, evaluating
   * each operand once per pair of rows, where MySQL hash joins it: the keyed join's JSON hash.
   */
  readonly nestedLoopJoin?: Pick<KeyedJoinSyntax, "jsonHash">;
  /**
   * A one-row table, without its alias, holding values the enclosing row computes. MySQL reads an
   * outer column inside a derived table; MariaDB reads one only inside `JSON_TABLE`.
   */
  hold(columns: readonly Held[]): Sql;
  /** {@link Flavour.hold} of one JSON value without nesting it deeper; no row where it is SQL NULL. */
  holdBare(held: Held): Sql;
  /** A JSON column of `JSON_TABLE` as a JSON value, which the JSON functions take whole. */
  tabled(column: Sql): Sql;
  /** ISO 8601 text, validated, read as the UTC instant it names, its `Z` or zone offset included. */
  instant(text: Sql): Sql;
  /** The text the engine casts to `DATETIME(6)` as the UTC instant `date` holds. */
  instantText(date: Date): string;
  /** Whether `text` matches the translated `pattern`, case-sensitively. */
  matches(text: Sql, pattern: Sql): Sql;
  /** How `REGEXP_REPLACE` names the text a pattern's numbered group captured. */
  captured(group: number): string;
  /**
   * `information_schema.COLUMNS`' default and `EXTRA` as MySQL spells them: the default's own text,
   * NULL for none, and `DEFAULT_GENERATED` among the extras of a default that is an expression.
   */
  readonly columnDefault: { readonly value: Sql; readonly extra: Sql };
  /** Whether an index of `information_schema.STATISTICS` is one the optimizer may use, `YES` or `NO`. */
  readonly indexVisible: Sql;
  /** External mode's catalog member naming a relation's JSON columns, where its columns cannot tell. */
  readonly jsonColumns?: ExternalCatalogSyntax["jsonColumns"];
  /**
   * A catalog column's type as the catalog reads it, from `information_schema.COLUMNS` at `column`,
   * for a column of `table` in the connection's database.
   */
  catalogType(column: Sql, table: string): Sql;
}

/** The digits of the largest row number, to which an ordinal is padded so its text sorts as it does. */
const ORDINAL_DIGITS = 20;

/** The rest of a JSON number equal to zero after its sign and first `0`; `0.5` and `05` are not one. */
const ZERO_REST = String.raw`(?:\.0+)?(?:[eE][-+]?[0-9]+)?(?![0-9.eE])`;

/** The parts of JSON text that hold no zero spelled other than `0`, such as `-0` or `0.0`. */
const NO_SPELLED_ZERO = [
  String.raw`[^"0-9-]++`,
  String.raw`"(?:[^"\\]++|\\.)*+"`,
  String.raw`-?[1-9][0-9]*+(?:\.[0-9]++)?(?:[eE][-+]?[0-9]++)?`,
  String.raw`-?0\.0*+[1-9][0-9]*+(?:[eE][-+]?[0-9]++)?`,
  String.raw`0(?![.eE])`,
].join("|");

/**
 * The next zero of JSON text spelled other than `0`: the text before it in group 1 and its first `0`
 * in group 2. `\G` starts each match where the last one ended, and group 1 crosses whole strings and
 * other numbers, so no `-` or digit inside either is read as a zero. Every quantifier is possessive,
 * since the parts of group 1 never overlap.
 */
const NEXT_SPELLED_ZERO = String.raw`\G((?:${NO_SPELLED_ZERO})*+)-?(0)${ZERO_REST}`;

/** The parts of JSON text that hold no integer spelled with a fraction of zeros, such as `1.0`. */
const NO_ZERO_FRACTION = [
  String.raw`[^"0-9-]++`,
  String.raw`"(?:[^"\\]++|\\.)*+"`,
  String.raw`-?[0-9]++(?:\.[0-9]++)?[eE][-+]?[0-9]++`,
  String.raw`-?[0-9]++\.0*+[1-9][0-9]*+`,
  String.raw`-?[0-9]++(?![.eE])`,
].join("|");

/**
 * The next integer of JSON text spelled with a fraction of zeros and no exponent: the text before it
 * in group 1 and its integer part in group 2, read as {@link NEXT_SPELLED_ZERO} reads a zero.
 */
const NEXT_ZERO_FRACTION = String.raw`\G((?:${NO_ZERO_FRACTION})*+)(-?[0-9]++)\.0++(?![0-9eE])`;

/**
 * JSON text with each zero spelled `0` and each integer's fraction of zeros dropped, a nested one
 * included, so a value spells the same text as another with a number spelled `1.0` rather than `1`,
 * or a zero of another sign or type, where `DISTINCT` finds the two equal. `sigil` is what the
 * engine's replacement puts before a group's number. SQL NULL stays SQL NULL.
 */
export function RespelledNumbers(text: Sql, sigil: "$" | "\\"): Sql {
  const groups = lit(`${sigil}1${sigil}2`);
  return sql`REGEXP_REPLACE(REGEXP_REPLACE(${text}, ${lit(NEXT_SPELLED_ZERO)}, ${groups}), ${lit(NEXT_ZERO_FRACTION)}, ${groups})`;
}

/**
 * The most characters of JSON text whose numbers a dedup key respells. MySQL stops a regular
 * expression at `regexp_time_limit`, which {@link RespelledNumbers} reaches at the default near 48,000
 * characters of an array of one-digit numbers, the text with the most parts per character.
 */
const MAX_RESPELLED_CHARS = 32768;

/**
 * The key a dedup gives a value's JSON text: its {@link RespelledNumbers}. Longer text keeps its own
 * spelling, so two such values that differ only in a number's spelling stay apart.
 */
function DedupKey(text: Sql): Sql {
  return sql`(CASE WHEN CHAR_LENGTH(${text}) <= ${int(MAX_RESPELLED_CHARS)} THEN ${RespelledNumbers(text, "$")} ELSE ${text} END)`;
}

/**
 * Collects JSON values without reading any back from text, since MySQL 8.4's JSON parser reads some
 * doubles of 17 significant digits as a neighbour. `JSON_ARRAYAGG` takes no order, so an ordered
 * array is first an object keyed by each row's ordinal at a fixed width: the server keeps an
 * object's keys sorted, and `$.*` reads its members in that order. A dedup keys each element by its
 * {@link DedupKey} instead, which keeps one element per value as `DISTINCT` compares JSON, and an
 * absent element by the empty key, which no JSON text is, so it stays apart from a JSON null as a
 * dedup at the top does. An absent element reads back as a JSON null either way.
 */
function Collect(
  element: Sql,
  ordinal: Sql | undefined,
  distinct: boolean,
  textOf: (value: Sql) => Sql,
): Sql {
  if (ordinal === undefined && !distinct) {
    return sql`COALESCE(JSON_ARRAYAGG(${element}), JSON_ARRAY())`;
  }
  const key =
    ordinal === undefined
      ? sql`COALESCE(${DedupKey(textOf(element))}, '')`
      : sql`LPAD(${ordinal}, ${int(ORDINAL_DIGITS)}, '0')`;
  return sql`COALESCE(JSON_EXTRACT(JSON_OBJECTAGG(${key}, ${element}), '$.*'), JSON_ARRAY())`;
}

/** How the row reads back a value {@link Flavour.hold} holds at `alias`. */
export function HeldRead(flavour: Flavour, alias: string, held: Held): Sql {
  const column = sql`${ident(alias)}.${ident(held.name)}`;
  return held.kind === "text" ? column : flavour.tabled(column);
}

const UTC_DESIGNATOR = /Z$/;
const UTC_OFFSET = "+00:00";

/**
 * The longest `CHAR` a `RETURNING` clause takes. `JSON_VALUE` answers SQL NULL for a string longer
 * than its type, `VARCHAR(512)` by default.
 */
const MAX_TEXT_CHARS = 4294967295;

/** 2^63, the first magnitude a `SIGNED` cannot hold, as a double. */
const SIGNED_BOUND = sql`9223372036854775808e0`;

/** 2^63 as an exact decimal, which a decimal just below it compares under, where a double rounds. */
const SIGNED_BOUND_DECIMAL = sql`9223372036854775808`;

/**
 * MySQL parses `1` as an integer and `1.0` as a double, keeps `CAST(1.0 AS JSON)` as a decimal, and
 * spells the three apart, so a double or a decimal that holds an integer becomes that integer, -0
 * becoming 0. A decimal is read as one, which keeps the digits a double would round. The type name
 * is compared as bytes: `JSON_TYPE` answers in `utf8mb4_bin`, which a literal in the session's
 * collation cannot be compared with.
 */
function CanonicalNumber(value: Sql): Sql {
  const type = sql`CAST(JSON_TYPE(${value}) AS BINARY)`;
  const integer = (number: Sql, bound: Sql) =>
    sql`${number} = FLOOR(${number}) AND ABS(${number}) < ${bound}`;
  const double = sql`JSON_VALUE(${value}, '$' RETURNING DOUBLE)`;
  const decimal = sql`JSON_VALUE(${value}, '$' RETURNING DECIMAL(65, 30))`;
  return sql`(CASE WHEN ${type} = 'DOUBLE' AND ${integer(double, SIGNED_BOUND)} THEN CAST(CAST(${double} AS SIGNED) AS JSON) WHEN ${type} = 'DECIMAL' AND ${integer(decimal, SIGNED_BOUND_DECIMAL)} THEN CAST(CAST(${decimal} AS SIGNED) AS JSON) ELSE ${value} END)`;
}

/**
 * MySQL 8.4 LTS and 9.7 LTS. MySQL 8.4's JSON parser reads some doubles of 17 significant digits as
 * a neighbour, and JSON text spells a negative zero `0`, so of the finite numbers only a safe
 * integer other than -0 survives the text; any other goes as a bound `DOUBLE`.
 */
export const MYSQL: Flavour = {
  id: "mysql",
  name: "MySQL",
  binaryCollation: "utf8mb4_0900_bin",
  jsonType: sql`JSON`,
  maxJsonNesting: 100,
  tooDeepErrno: 3157,
  warnsTooDeep: false,
  heldNesting: 0,
  multiValuedIndex: true,
  pinned: [],
  readTimeout: (ms) => sql`max_execution_time = ${int(ms)}`,
  uncapped: (statement) => statement,
  readTimeoutErrnos: [3024],
  checkViolation: {
    errno: 3819,
    named: /^Check constraint '((?:[^']|'')*)' is violated/,
  },
  json: (text) => sql`CAST(${text} AS JSON)`,
  present: (value) => sql`NULLIF(${value}, CAST('null' AS JSON))`,
  absent: (value) =>
    sql`((${value} IS NULL) OR (${value} = CAST('null' AS JSON)))`,
  value: (document, path) =>
    sql`JSON_VALUE(${document}, ${path} RETURNING CHAR(${int(MAX_TEXT_CHARS)}))`,
  valueIsRead: true,
  number: (value) => sql`CAST(${value} AS JSON)`,
  canonicalNumber: CanonicalNumber,
  keepsInText: (value) => Number.isSafeInteger(value) && !Object.is(value, -0),
  boolean: (truth) => sql`CAST(${truth} AS JSON)`,
  includes: (array, element) => sql`(${element} MEMBER OF (${array}))`,
  collect: Collect,
  returning: false,
  lateral: true,
  outerInTableFunction: false,
  hold: (columns) =>
    sql`(SELECT ${join(
      columns.map((held) => sql`${held.value} AS ${ident(held.name)}`),
      sql`, `,
    )})`,
  holdBare: (held) => sql`(SELECT ${held.value} AS ${ident(held.name)})`,
  tabled: (column) => column,
  instant: (text) =>
    sql`CAST(REPLACE(${text}, 'Z', ${lit(UTC_OFFSET)}) AS DATETIME(6))`,
  instantText: (date) => date.toISOString().replace(UTC_DESIGNATOR, UTC_OFFSET),
  matches: (text, pattern) => sql`REGEXP_LIKE(${text}, ${pattern}, 'c')`,
  captured: (group) => `$${group}`,
  columnDefault: { value: sql`COLUMN_DEFAULT`, extra: sql`EXTRA` },
  indexVisible: sql`IS_VISIBLE`,
  catalogType: (column) => sql`${column}.${ident("COLUMN_TYPE")}`,
};
