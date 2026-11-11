import type { BindSyntax, ScalarKind, ScalarSyntax } from "../sql-types";
import { type Sql, int, join, lit, param, sql } from "../../statement";

/** A decimal literal with an optional sign, exponent and surrounding space, and nothing else. */
const NUMERIC_TEXT = lit(
  "^\\s*[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?[0-9]+)?\\s*$",
);

const UTC_DESIGNATOR = /Z$/;
const UTC_OFFSET = "+00:00";

const CASTS: Record<ScalarKind, (value: Sql) => Sql> = {
  text: (value) => sql`CAST(${value} AS CHAR)`,
  float: (value) => sql`CAST(${value} AS DOUBLE)`,
  timestamp: (value) => sql`CAST(${value} AS DATETIME(6))`,
  bool: (value) => sql`((${value}) <> 0)`,
};

/**
 * A number is cast to `DOUBLE`, since the driver sends an integer as a `BIGINT`. A boolean goes as
 * 1 or 0 and is compared with 0, which also marks it a boolean wherever the server turns it into
 * JSON. An instant goes as its ISO text with an explicit `+00:00`: the server reads an offset but
 * not `Z`, which a statement that writes refuses.
 */
const bind: BindSyntax = {
  text: (value) => param(value),
  float: (value) => sql`CAST(${param(value)} AS DOUBLE)`,
  bool: (value) => sql`(${param(value ? 1 : 0)} <> 0)`,
  timestamp: (value) =>
    Number.isNaN(value.getTime())
      ? sql`CAST(NULL AS DATETIME(6))`
      : sql`CAST(${param(value.toISOString().replace(UTC_DESIGNATOR, UTC_OFFSET))} AS DATETIME(6))`,
  json: (value) => sql`CAST(${param(JSON.stringify(value))} AS JSON)`,
};

export const scalar: ScalarSyntax = {
  cast: (value, kind) => CASTS[kind](value),
  bind,
  parseNumber: (text) =>
    sql`(CASE WHEN ${text} REGEXP ${NUMERIC_TEXT} THEN CAST(${text} AS DOUBLE) END)`,
  truncate: (value) => sql`TRUNCATE(${value}, 0)`,
  concat: (parts) => sql`CONCAT(${join(parts, sql`, `)})`,
  left: (text, width) => sql`LEFT(${text}, ${int(width)})`,
};
