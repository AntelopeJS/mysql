import { type Sql, ident, int, join, lit, sql } from "../../statement";
import type { ExternalCatalogSyntax } from "../external";
import type { JsonSyntax } from "../sql-types";

/** A value a one-row table holds, which the row reads back as a JSON value or as text. */
export interface Held {
  readonly name: string;
  readonly value: Sql;
  readonly kind: "json" | "text";
}

/**
 * What MySQL and MariaDB spell differently. Every other statement this directory writes is the same
 * on both, so each of its modules is a function of one flavour, and an engine of the family is one
 * flavour.
 */
export interface Flavour {
  /** The engine's name, as `SELECT VERSION()` tells it and external mode's catalog reports it. */
  readonly id: "mysql" | "mariadb";
  /** The binary, NO PAD collation of every text column, literal and bound parameter. */
  readonly binaryCollation: string;
  /** The column type of a JSON document, in the binary collation. */
  readonly jsonType: Sql;
  /** The most containers a stored JSON document nests. */
  readonly maxJsonNesting: number;
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
  /** A double as a JSON number, a negative zero included. */
  number(value: Sql): Sql;
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
  /**
   * A one-row table, without its alias, holding values the enclosing row computes. MySQL reads an
   * outer column inside a derived table; MariaDB reads one only inside `JSON_TABLE`.
   */
  hold(columns: readonly Held[]): Sql;
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

/**
 * Collects JSON values without reading any back from text, since MySQL 8.4's JSON parser reads some
 * doubles of 17 significant digits as a neighbour. `JSON_ARRAYAGG` takes no order, so an ordered
 * array is first an object keyed by each row's ordinal at a fixed width: the server keeps an
 * object's keys sorted, and `$.*` reads its members in that order. A dedup keys each element by its
 * text instead, which keeps one element per text. An absent element is a JSON null either way.
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
      ? sql`COALESCE(${textOf(element)}, 'null')`
      : sql`LPAD(${ordinal}, ${int(ORDINAL_DIGITS)}, '0')`;
  return sql`COALESCE(JSON_EXTRACT(JSON_OBJECTAGG(${key}, ${element}), '$.*'), JSON_ARRAY())`;
}

/** How the row reads back a value {@link Flavour.hold} holds at `alias`. */
export function HeldRead(flavour: Flavour, alias: string, held: Held): Sql {
  const column = sql`${ident(alias)}.${ident(held.name)}`;
  return held.kind === "json" ? flavour.tabled(column) : column;
}

const UTC_DESIGNATOR = /Z$/;
const UTC_OFFSET = "+00:00";

/**
 * MySQL 8.4 LTS and 9.7 LTS. MySQL 8.4's JSON parser reads some doubles of 17 significant digits as
 * a neighbour, and JSON text spells a negative zero `0`, so of the finite numbers only a safe
 * integer other than -0 survives the text; any other goes as a bound `DOUBLE`.
 */
export const MYSQL: Flavour = {
  id: "mysql",
  binaryCollation: "utf8mb4_0900_bin",
  jsonType: sql`JSON`,
  maxJsonNesting: 100,
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
  number: (value) => sql`CAST(${value} AS JSON)`,
  keepsInText: (value) => Number.isSafeInteger(value) && !Object.is(value, -0),
  boolean: (truth) => sql`CAST(${truth} AS JSON)`,
  includes: (array, element) => sql`(${element} MEMBER OF (${array}))`,
  collect: Collect,
  returning: false,
  lateral: true,
  hold: (columns) =>
    sql`(SELECT ${join(
      columns.map((held) => sql`${held.value} AS ${ident(held.name)}`),
      sql`, `,
    )})`,
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
