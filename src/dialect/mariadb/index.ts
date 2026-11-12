import { type Flavour, type Held, FamilyDialect } from "../mysql";
import { type Sql, ident, int, join, lit, sql } from "../../statement";
import type { Row } from "../../connection";

const BINARY_COLLATION = "utf8mb4_nopad_bin";

/**
 * The largest `group_concat_max_len`. MariaDB builds `JSON_ARRAYAGG` and `JSON_OBJECTAGG` on its
 * group concatenation, which truncates an aggregate at this many bytes.
 */
const UNBOUNDED_AGGREGATE_BYTES = 4294967295;

/** MariaDB's statement timeout, in seconds, which a fraction of a second refines. */
const MS_PER_SECOND = 1000;

/**
 * MariaDB 11.8's JSON functions refuse a document of 32 nested containers, and its `json_valid`
 * check with them; 12.3 nests deeper, and the lower limit holds on both.
 */
const MAX_JSON_NESTING = 31;

/** `max_statement_time` stopped a statement. */
const STATEMENT_TIMEOUT = 1969;

const OFFSET_CHARS = 6;
const ZONE_OFFSET = lit(`[+-][0-9]{2}:[0-9]{2}$`);
const UTC_DESIGNATOR = /Z$/;

/**
 * Text as a JSON value. MariaDB stores a document as text and has no JSON type to cast to, but the
 * text a JSON function answers is JSON to every other JSON function. The text is taken into the
 * session's collation first: `JSON_QUOTE` answers in another one, which `JSON_OBJECT` refuses to
 * mix with the key beside it.
 */
function Json(text: Sql): Sql {
  return sql`JSON_EXTRACT(CONVERT(${text} USING utf8mb4) COLLATE ${ident(BINARY_COLLATION)}, '$')`;
}

/**
 * Equality as JSON: a number however it is spelled, an object whatever its key order. `JSON_EQUALS`
 * is compared with 1 rather than read as a truth, which MariaDB 11.8 and 12.3 take to hold where it
 * is SQL NULL, in a `WHERE` and a `CASE` alike.
 */
function JsonEquals(left: Sql, right: Sql): Sql {
  return sql`(JSON_EQUALS(${left}, ${right}) = 1)`;
}

/**
 * Whether one element of the array equals the element as JSON does. `JSON_CONTAINS` would also
 * find it inside a nested array or object, and MariaDB has no `MEMBER OF`. The element goes through
 * `JSON_ARRAY` so a scalar and a JSON value both arrive as JSON.
 */
function Includes(array: Sql, element: Sql): Sql {
  const member = ident("__member");
  const value = ident("value");
  const elements = sql`JSON_TABLE(${array}, '$[*]' COLUMNS (${value} JSON PATH '$')) AS ${member}`;
  const found = sql`EXISTS (SELECT 1 FROM ${elements} WHERE ${JsonEquals(sql`${member}.${value}`, sql`JSON_EXTRACT(JSON_ARRAY(${element}), '$[0]')`)})`;
  return sql`(CASE WHEN ${array} IS NULL OR ${element} IS NULL THEN NULL ELSE ${found} END)`;
}

/**
 * MariaDB writes a negative zero as `0`, so one is spelled `-0`, which JSON text keeps; `ATAN2`
 * tells it from a positive zero, which compares equal to it.
 */
function JsonNumber(value: Sql): Sql {
  return Json(
    sql`IF(${value} = 0 AND ATAN2(${value}, -1) < 0, '-0', ${value})`,
  );
}

/**
 * `JSON_ARRAYAGG` takes an order on MariaDB. A dedup keeps one element per text, as MySQL's does,
 * an absent element being a JSON null; MariaDB keeps an object's keys in the order they were
 * written, so two objects that differ only in that order are both kept.
 */
function Collect(
  element: Sql,
  ordinal: Sql | undefined,
  distinct: boolean,
): Sql {
  if (distinct) {
    const present = sql`COALESCE(${element}, ${Json(lit("null"))})`;
    return sql`COALESCE(JSON_ARRAYAGG(DISTINCT ${present}), JSON_ARRAY())`;
  }
  const order = ordinal === undefined ? sql`` : sql` ORDER BY ${ordinal}`;
  return sql`COALESCE(JSON_ARRAYAGG(${element}${order}), JSON_ARRAY())`;
}

/**
 * MariaDB's cast reads a zone offset and drops it, so an offset is applied by `CONVERT_TZ`, and a
 * `Z` is dropped since the session is UTC.
 */
function Instant(text: Sql): Sql {
  const local = sql`CAST(LEFT(${text}, CHAR_LENGTH(${text}) - ${int(OFFSET_CHARS)}) AS DATETIME(6))`;
  const offset = sql`RIGHT(${text}, ${int(OFFSET_CHARS)})`;
  return sql`(CASE WHEN ${text} REGEXP ${ZONE_OFFSET} THEN CONVERT_TZ(${local}, ${offset}, '+00:00') ELSE CAST(REPLACE(${text}, 'Z', '') AS DATETIME(6)) END)`;
}

/**
 * The values go into one JSON array, which `JSON_TABLE` reads back as the table's one row: MariaDB
 * reads an outer column inside `JSON_TABLE` but not inside a derived table.
 */
function Hold(columns: readonly Held[]): Sql {
  const values = join(
    columns.map((held) => held.value),
    sql`, `,
  );
  const definitions = columns.map((held, position) => {
    const type =
      held.kind === "json"
        ? sql`JSON`
        : sql`LONGTEXT COLLATE utf8mb4_nopad_bin`;
    return sql`${ident(held.name)} ${type} PATH ${lit(`$[${position}]`)}`;
  });
  return sql`JSON_TABLE(JSON_ARRAY(${values}), '$' COLUMNS (${join(definitions, sql`, `)}))`;
}

/**
 * MariaDB's `COLUMN_DEFAULT` quotes a literal, spells a nullable column's default `NULL` as text and
 * leaves an expression bare; MySQL's leaves a literal bare and marks an expression in `EXTRA`.
 */
const DEFAULT_IS_NULL = sql`(COLUMN_DEFAULT IS NULL OR COLUMN_DEFAULT = 'NULL')`;
const DEFAULT_IS_QUOTED = sql`(LEFT(COLUMN_DEFAULT, 1) = ${lit("'")})`;
const LITERAL_DEFAULT = lit("^([-+]?[0-9.]+(e[-+]?[0-9]+)?|[bx]'.*')$");
const DEFAULT_IS_EXPRESSION = sql`NOT (${DEFAULT_IS_NULL} OR ${DEFAULT_IS_QUOTED} OR COLUMN_DEFAULT REGEXP ${LITERAL_DEFAULT})`;

/**
 * Whether a catalog column holds JSON. MariaDB reports a JSON column as `longtext` with a
 * `json_valid` check, which is all that tells it from a text column.
 */
function IsJsonColumn(column: Sql): Sql {
  const name = sql`${column}.COLUMN_NAME`;
  const check = sql`CONCAT('json_valid(\`', REPLACE(${name}, '\`', '\`\`'), '\`)')`;
  return sql`EXISTS (SELECT 1 FROM information_schema.CHECK_CONSTRAINTS AS k WHERE k.CONSTRAINT_SCHEMA = ${column}.TABLE_SCHEMA AND k.TABLE_NAME = ${column}.TABLE_NAME AND k.CHECK_CLAUSE = ${check})`;
}

/** A JSON column reads as the JSON type it was created with, collation included. */
function CatalogType(column: Sql): Sql {
  return sql`IF(${IsJsonColumn(column)}, CONCAT('json collate ', ${column}.COLLATION_NAME), ${column}.COLUMN_TYPE)`;
}

const CREATE_TABLE = "Create Table";
const JSON_CHECK = /json_valid\(`((?:[^`]|``)+)`\)/g;

/**
 * The columns a relation's definition checks as JSON. `SHOW CREATE TABLE` answers any account that
 * holds a privilege on the relation, where `information_schema.CHECK_CONSTRAINTS` answers only one
 * granted the whole schema.
 */
function JsonChecked(rows: readonly Row[]): ReadonlySet<string> {
  const definition = rows
    .map((row) => {
      const cell = row.get(CREATE_TABLE);
      return Buffer.isBuffer(cell) ? cell.toString("utf8") : String(cell);
    })
    .join("\n");
  return new Set(
    [...definition.matchAll(JSON_CHECK)].map((match) =>
      match[1].replaceAll("``", "`"),
    ),
  );
}

/** MariaDB 11.8 LTS and 12.3 LTS. */
const MARIADB: Flavour = {
  id: "mariadb",
  binaryCollation: BINARY_COLLATION,
  jsonType: sql`JSON COLLATE utf8mb4_nopad_bin`,
  maxJsonNesting: MAX_JSON_NESTING,
  multiValuedIndex: false,
  pinned: [sql`group_concat_max_len = ${int(UNBOUNDED_AGGREGATE_BYTES)}`],
  readTimeout: (ms) =>
    sql`max_statement_time = ${int(ms)} / ${int(MS_PER_SECOND)}`,
  readTimeoutErrnos: [STATEMENT_TIMEOUT],
  checkViolation: {
    errno: 4025,
    named: /^CONSTRAINT `((?:[^`]|``)*)` failed for /,
  },
  jsonEquals: JsonEquals,
  json: Json,
  number: JsonNumber,
  keepsInText: (value) => !Object.is(value, -0),
  boolean: (truth) =>
    sql`(CASE ${truth} WHEN TRUE THEN ${Json(lit("true"))} WHEN FALSE THEN ${Json(lit("false"))} END)`,
  includes: Includes,
  collect: Collect,
  collectInOrder: (element, order) =>
    sql`COALESCE(JSON_ARRAYAGG(${element} ORDER BY ${order}), JSON_ARRAY())`,
  returning: true,
  lateral: false,
  hold: Hold,
  tabled: Json,
  instant: Instant,
  instantText: (date) =>
    date.toISOString().replace("T", " ").replace(UTC_DESIGNATOR, ""),
  matches: (text, pattern) => sql`(${text} REGEXP CONCAT('(?-i)', ${pattern}))`,
  captured: (group) => `\\${group}`,
  columnDefault: {
    value: sql`(CASE WHEN ${DEFAULT_IS_NULL} THEN NULL WHEN ${DEFAULT_IS_QUOTED} THEN REPLACE(SUBSTRING(COLUMN_DEFAULT, 2, CHAR_LENGTH(COLUMN_DEFAULT) - 2), ${lit("''")}, ${lit("'")}) ELSE COLUMN_DEFAULT END)`,
    extra: sql`CONCAT(EXTRA, IF(${DEFAULT_IS_EXPRESSION}, ' DEFAULT_GENERATED', ''))`,
  },
  indexVisible: sql`IF(IGNORED = 'YES', 'NO', 'YES')`,
  jsonColumns: {
    read: (schema, table) =>
      sql`SHOW CREATE TABLE ${ident(schema)}.${ident(table)}`,
    parse: JsonChecked,
  },
  catalogType: CatalogType,
};

/** MariaDB 11.8 LTS and 12.3 LTS. */
export const mariadb = FamilyDialect(MARIADB);
