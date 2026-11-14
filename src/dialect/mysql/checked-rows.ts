import {
  Bind,
  MAX_IDENTIFIER_CHARS,
  type Sql,
  ident,
  int,
  lit,
  sql,
} from "../../statement";

/**
 * A call MariaDB can answer with a warning a read fails on: a JSON function, which MariaDB 11.8
 * answers SQL NULL past the nesting it builds, or an aggregate, which MariaDB cuts short at
 * `max_allowed_packet`.
 */
const MAY_WARN = /\b(?:JSON_\w+|GROUP_CONCAT)\s*\(/i;

/** The largest row count, which stands for none: MariaDB materializes a derived table with a `LIMIT`. */
const NO_LIMIT = sql`18446744073709551615`;

/** `ER_SUBQUERY_NO_1_ROW`, which the check raises. */
const CHECK_FAILED = 1242;

const ROWS = ident("checked");

/** The check's alias, longer than any column's name, so no decoder reads it as a column of the row. */
const CHECK = lit("raised a warning".padEnd(MAX_IDENTIFIER_CHARS + 1, "_"));

/**
 * `statement` as a cursor streams it on MariaDB: computed whole before the server sends its first
 * row, which fails with `Subquery returns more than 1 row` where computing the rows raised more than
 * `tolerated` warnings, and holds one more column, which no decoder reads. A statement that calls
 * no JSON function and no aggregate raises no warning a read fails on, and streams as it is.
 *
 * MariaDB lists a statement's warnings only once it has ended, and a cursor hands rows over before
 * then. `@@warning_count`, read inside a statement, counts the warnings it has raised so far, and
 * the server reads it once per statement. The subquery that reads it calls `RAND()`, so the server
 * runs it for the first row it sends rather than while it plans the statement, which is after the
 * derived table has been filled; `RAND()` is below 1, so the sum passes `tolerated` only with one
 * warning more.
 */
export function CheckedRows(statement: Sql, tolerated: number): Sql {
  if (!MAY_WARN.test(Bind(statement).sql)) {
    return statement;
  }
  const twice = sql`(VALUES (1), (2)) AS ${ident("twice")}`;
  const check = sql`(SELECT 1 FROM ${twice} WHERE @@warning_count + RAND() >= ${int(tolerated + 1)})`;
  return sql`SELECT ${ROWS}.*, ${check} AS ${CHECK} FROM ((${statement}) LIMIT ${NO_LIMIT}) AS ${ROWS}`;
}

/** Whether a statement {@link CheckedRows} wrote failed at its check, or at a subquery of its own. */
export function CheckFailed(error: Error): boolean {
  return "errno" in error && error.errno === CHECK_FAILED;
}
