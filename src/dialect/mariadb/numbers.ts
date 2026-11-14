import { RespelledNumbers } from "../mysql";
import { type Sql, int, sql } from "../../statement";
import { Json } from "./json-text";

/**
 * Equality as JSON: a number however it is spelled, an object whatever its key order. `JSON_EQUALS`
 * is compared with 1 rather than read as a truth, which MariaDB 11.8 and 12.3 take to hold where it
 * is SQL NULL, in a `WHERE` and a `CASE` alike.
 */
export function JsonEquals(left: Sql, right: Sql): Sql {
  return sql`(JSON_EQUALS(${left}, ${right}) = 1)`;
}

/**
 * `JSON_EQUALS` holds where the two values normalize to the same text, so that text's CRC-32, in
 * one character set whatever the value's, is shared by every pair it holds for.
 */
export function JsonHash(value: Sql): Sql {
  return sql`CRC32(CONVERT(JSON_NORMALIZE(${value}) USING utf8mb4))`;
}

/**
 * MariaDB writes a negative zero as `0`, so one is spelled `-0`, which JSON text keeps; `ATAN2`
 * tells it from a positive zero, which compares equal to it.
 */
export function JsonNumber(value: Sql): Sql {
  return Json(
    sql`IF(${value} = 0 AND ATAN2(${value}, -1) < 0, '-0', ${value})`,
  );
}

/** 2^63, the first magnitude a `SIGNED` cannot hold. */
const SIGNED_BOUND = sql`9223372036854775808e0`;

/** The greatest double, which MariaDB's cast answers for a number beyond it. */
const GREATEST_DOUBLE = sql`1.7976931348623157e308`;

/** The greatest double's decimal exponent. */
const GREATEST_EXPONENT = 308;

/**
 * The JSON syntax's `canonicalNumber` on MariaDB, which stores JSON as text and dedups by it. A
 * container's text has each zero spelled `0`, a nested one included. A number's text is as written,
 * `-0`, `0.0` and `1.0` included, and `JSON_TYPE` calls `15e-1` an integer, so the text decides. An
 * integer literal keeps its digits, which a double would round past 2^53, with `-0` read as `0`. Any
 * other number is read as a double, as MySQL parses it: an integer one as its digits, the rest as
 * the shortest text MariaDB writes for it. The cast caps a number beyond the doubles at the greatest
 * one, so a number that casts to it with an exponent past 308 keeps its text; so does a spelling of
 * the greatest double itself with such an exponent, as `0.17976931348623157e309`. The exponent is
 * read as a decimal, which caps one past a `SIGNED` above 308.
 */
export function CanonicalNumber(value: Sql): Sql {
  const number = sql`JSON_TYPE(${value}) IN ('INTEGER', 'DOUBLE')`;
  const text = sql`JSON_COMPACT(${value})`;
  const double = sql`CAST(JSON_VALUE(${value}, '$') AS DOUBLE)`;
  const integral = sql`${double} = FLOOR(${double}) AND ABS(${double}) < ${SIGNED_BOUND}`;
  const exponent = sql`CAST(SUBSTRING(REGEXP_SUBSTR(${text}, '[eE][+-]?[0-9]+$'), 2) AS DECIMAL(65, 0))`;
  const finite = sql`(ABS(${double}) < ${GREATEST_DOUBLE} OR ${exponent} <= ${int(GREATEST_EXPONENT)})`;
  return Json(
    sql`(CASE WHEN NOT ${number} THEN ${RespelledNumbers(value, "\\")} WHEN ${text} REGEXP '^-?[0-9]+$' THEN REGEXP_REPLACE(${text}, '^-0$', '0') WHEN ${integral} THEN CAST(${double} AS SIGNED) WHEN ${finite} THEN ${double} ELSE ${text} END)`,
  );
}
