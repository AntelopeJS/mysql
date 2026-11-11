import type { Dialect } from "../../dialect";
import type { JsonKind } from "../../dialect/sql-types";
import { type Sql, sql } from "../../statement";
import type { Compiled } from "./sql";

/**
 * Yields SQL NULL rather than an error or a wrong answer when the operand is not the expected kind
 * of JSON value. A path or a walk over the wrong kind reads a scalar as a one-element list and an
 * object as its own member, and the type test is NULL for SQL NULL, so the same `CASE` also
 * carries a NULL operand through.
 */
export function GuardJson(
  dialect: Dialect,
  value: Compiled,
  expected: JsonKind,
  body: Sql,
): Sql {
  return sql`(CASE WHEN ${dialect.sql.json.is(value.sql, [expected])} THEN ${body} END)`;
}
