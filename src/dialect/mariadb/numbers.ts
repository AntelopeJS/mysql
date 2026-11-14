import { RespelledNumbers } from "../mysql";
import { type Sql, ident, int, sql } from "../../statement";
import { BINARY_COLLATION, Json } from "./json-text";

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

/** 2^64, the first magnitude an `UNSIGNED` cannot hold. */
const UNSIGNED_BOUND = sql`18446744073709551616e0`;

/** -2^63, the least integer MySQL's JSON parser keeps exactly. */
const SIGNED_MIN = sql`-9223372036854775808`;

/** 2^64 - 1, the greatest integer MySQL's JSON parser keeps exactly. */
const UNSIGNED_MAX = sql`18446744073709551615`;

/** The greatest double, which MariaDB's cast answers for a number beyond it. */
const GREATEST_DOUBLE = sql`1.7976931348623157e308`;

/** The greatest double's decimal exponent. */
const GREATEST_EXPONENT = 308;

/**
 * {@link RespelledNumbers} of JSON text read as its UTF-8 bytes. A MariaDB regular expression over
 * text in a UTF-8 character set takes time in the square of the text's length, and over bytes in
 * its length. The patterns read only ASCII, which no byte of a longer UTF-8 character is, so the
 * bytes respell as the characters do.
 */
function RespelledBytes(value: Sql): Sql {
  const bytes = sql`CAST(CONVERT(${value} USING utf8mb4) AS BINARY)`;
  return sql`CONVERT(${RespelledNumbers(bytes)} USING utf8mb4) COLLATE ${ident(BINARY_COLLATION)}`;
}

/**
 * The JSON syntax's `canonicalNumber` on MariaDB, which stores JSON as text and dedups by it. An
 * array whose text holds no `{` is its `JSON_NORMALIZE` text, as {@link JsonEquals} compares it,
 * each nested number in one exact spelling: `1`, `1.0`, `1e0`, `10e-1` and `1.` alike. Text with a
 * `{` may hold an object, which is left out, since 12.3 writes its keys back unescaped and both
 * versions reorder a repeated key's members. Any other container's text has each zero spelled `0` and each fraction of zeros dropped,
 * a nested one included. A number's text is as written,
 * `-0`, `0.0` and `1.0` included, and `JSON_TYPE` calls `15e-1` an integer, so the text decides. An
 * integer literal from -2^63 to 2^64 - 1 keeps its digits, which a double would round past 2^53,
 * with `-0` read as `0`; MySQL reads a longer one as a double. Any
 * other number is read as a double, as MySQL parses it: an integer one below 2^63 as its digits, one
 * below 2^64 as the digits of its shortest decimal, as MySQL compares it with an integer, so `1e19`
 * meets `10000000000000000000`, the rest as
 * the shortest text MariaDB writes for it. The cast caps a number beyond the doubles at the greatest
 * one, so a number that casts to it with an exponent past 308 keeps its text, as does an integer literal of 309 digits or more; so does a spelling of
 * the greatest double itself with such an exponent, as `0.17976931348623157e309`. The exponent is
 * read as a decimal, which caps one past a `SIGNED` above 308.
 */
export function CanonicalNumber(value: Sql): Sql {
  const number = sql`JSON_TYPE(${value}) IN ('INTEGER', 'DOUBLE')`;
  const text = sql`JSON_COMPACT(${value})`;
  const double = sql`CAST(JSON_VALUE(${value}, '$') AS DOUBLE)`;
  const integral = sql`${double} = FLOOR(${double}) AND ABS(${double}) < ${SIGNED_BOUND}`;
  const unsigned = sql`${double} = FLOOR(${double}) AND ${double} >= ${SIGNED_BOUND} AND ${double} < ${UNSIGNED_BOUND}`;
  const exponent = sql`CAST(SUBSTRING(REGEXP_SUBSTR(${text}, '[eE][+-]?[0-9]+$'), 2) AS DECIMAL(65, 0))`;
  const finite = sql`(ABS(${double}) < ${GREATEST_DOUBLE} OR ${exponent} <= ${int(GREATEST_EXPONENT)})`;
  const flat = sql`JSON_TYPE(${value}) = 'ARRAY' AND INSTR(${value}, '{') = 0`;
  const exact = sql`${text} REGEXP '^-?[0-9]{1,20}$' AND CAST(${text} AS DECIMAL(65, 0)) BETWEEN ${SIGNED_MIN} AND ${UNSIGNED_MAX}`;
  return Json(
    sql`(CASE WHEN ${flat} THEN JSON_NORMALIZE(${value}) WHEN NOT ${number} THEN ${RespelledBytes(value)} WHEN ${exact} THEN REGEXP_REPLACE(${text}, '^-0$', '0') WHEN ${text} REGEXP '^-?[0-9]{309,}$' THEN ${text} WHEN ${integral} THEN CAST(${double} AS SIGNED) WHEN ${unsigned} THEN CAST(CAST(${double} AS DECIMAL(20, 0)) AS UNSIGNED) WHEN ${finite} THEN ${double} ELSE ${text} END)`,
  );
}
