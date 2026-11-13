import type { Flavour } from "../mysql";
import { type Sql, ident, lit, param, sql } from "../../statement";
import type { Row } from "../../connection";

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
function IsJsonColumn(column: Sql, table: string): Sql {
  const name = sql`${column}.COLUMN_NAME`;
  const check = sql`CONCAT('json_valid(\`', REPLACE(${name}, '\`', '\`\`'), '\`)')`;
  return sql`EXISTS (SELECT 1 FROM information_schema.CHECK_CONSTRAINTS AS k WHERE k.CONSTRAINT_SCHEMA = DATABASE() AND k.TABLE_NAME = ${param(table)} AND k.CHECK_CLAUSE = ${check})`;
}

/**
 * A JSON column reads as the JSON type it was created with, collation included. The checks are
 * read for the one table by name, which MariaDB opens alone, where a filter on the outer row's
 * table would read the checks of every table in the database.
 */
function CatalogType(column: Sql, table: string): Sql {
  return sql`IF(${IsJsonColumn(column, table)}, CONCAT('json collate ', ${column}.COLLATION_NAME), ${column}.COLUMN_TYPE)`;
}

const CREATE_TABLE = "Create Table";
/** A column's own definition line whose check validates that same column as JSON. */
const JSON_CHECK = /^\s*`((?:[^`]|``)+)` [^\n]*CHECK \(json_valid\(`\1`\)\)/gm;

/**
 * The columns a relation's definition checks as JSON. `SHOW CREATE TABLE` answers any account that
 * holds a privilege on the relation, where `information_schema.CHECK_CONSTRAINTS` answers only one
 * granted the whole schema. A column whose generation expression calls `json_valid` on another is
 * not one of them.
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

/** How MariaDB's catalog answers what a column holds, defaults to and how its indexes show. */
export const CATALOG: Pick<
  Flavour,
  "columnDefault" | "indexVisible" | "jsonColumns" | "catalogType"
> = {
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
