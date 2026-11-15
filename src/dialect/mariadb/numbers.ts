import { type Sql, ident, int, sql } from "../../statement";
import { BINARY_COLLATION, Json } from "./json-text";
import { ContainerKey, IsContainer, ShortNumbered } from "./containers";

/**
 * Equality as JSON: two numbers where they share a {@link NumberKey}, as MySQL's JSON `=` finds them,
 * and any other pair where `JSON_EQUALS` holds of their {@link Comparable} texts, an object whatever
 * its key order. `JSON_EQUALS`
 * compares numbers by their exact decimal values, so it finds `0.1` unequal to
 * `0.10000000000000001` and `18446744073709549568e0` equal to `18446744073709549568`, which MySQL,
 * reading each as a double or an integer, does not. Two {@link Short} numbers hold at most 15
 * significant digits, which tell normal doubles apart, so `JSON_EQUALS` answers for them. `JSON_EQUALS` is
 * compared with 1 rather than read as a truth, which MariaDB 11.8 and 12.3 take to hold where it is
 * SQL NULL, in a `WHERE` and a `CASE` alike.
 */
export function JsonEquals(left: Sql, right: Sql): Sql {
  const equals = sql`JSON_EQUALS(${left}, ${right}) = 1`;
  const comparable = sql`JSON_EQUALS(${Comparable(left)}, ${Comparable(right)}) = 1`;
  return sql`(CASE WHEN NOT (${IsNumber(left)} AND ${IsNumber(right)}) THEN ${comparable} WHEN ${Short(left)} AND ${Short(right)} THEN ${equals} ELSE ${NumberKey(left)} = ${NumberKey(right)} END)`;
}

/**
 * The CRC-32 of a number's {@link NumberKey} and of any other value's normalized {@link Comparable}
 * text, in one character set whatever the value's, which {@link JsonEquals} finds the same for every
 * pair it holds for: `JSON_EQUALS` holds where two values normalize to the same text.
 */
export function JsonHash(value: Sql): Sql {
  return sql`CRC32(CONVERT(IF(${IsNumber(value)}, ${NumberKey(value)}, ${Normalized(Comparable(value))}) USING utf8mb4))`;
}

/**
 * A value as `JSON_EQUALS` compares it as MySQL's JSON `=` does: a container that spells a number of
 * more than 15 digits or one with an exponent as its {@link ContainerKey}, each nested number as its
 * {@link NumberKey}, and any other value as it is. `JSON_EQUALS` compares nested numbers by their
 * exact decimal values, which tell numbers of at most 15 digits and no exponent apart as their
 * doubles do, and finds `[18446744073709549568e0]` unequal to `[18446744073709550000]`, which MySQL
 * reads as one double.
 */
function Comparable(value: Sql): Sql {
  return sql`(CASE WHEN ${IsContainer(value)} AND NOT ${ShortNumbered(value)} THEN ${Json(ContainerKey(value, NumberKey))} ELSE ${Json(value)} END)`;
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

/** The greatest double's significand, as a normalized text's leading 17 significant digits read it. */
const GREATEST_SIGNIFICAND = sql`1.7976931348623157`;

/** The characters of a normalized significand that hold 17 significant digits: a digit, `.`, 16 more. */
const SIGNIFICAND_CHARS = 18;

/**
 * The JSON syntax's `canonicalNumber` on MariaDB, which stores JSON as text and dedups by it. An
 * array or an object is its {@link ContainerKey} text, each nested number spelled as its
 * {@link NumberKey}, as {@link JsonEquals} compares it: `1`, `1.0`, `1e0` and `10e-1` alike, and
 * `0.1` and `0.10000000000000001` alike. A number is its {@link NumberKey}, and any other value its
 * text.
 */
export function CanonicalNumber(value: Sql): Sql {
  return sql`(CASE WHEN ${IsContainer(value)} THEN ${Json(ContainerKey(value, NumberKey))} WHEN NOT ${IsNumber(value)} THEN ${Json(value)} ELSE ${NumberKey(value)} END)`;
}

/**
 * `JSON_NORMALIZE` of a copy of a JSON text: MariaDB 11.8 and 12.3 read past the end of a column's
 * text that `JSON_NORMALIZE` reads in place, as in a `JSON_TABLE` column, and answer digits it does
 * not hold.
 */
function Normalized(value: Sql): Sql {
  return sql`JSON_NORMALIZE(CONCAT(${value}, ''))`;
}

function IsNumber(value: Sql): Sql {
  return sql`JSON_TYPE(${value}) IN ('INTEGER', 'DOUBLE')`;
}

/** The most characters of a number's text that hold at most 15 significant digits. */
const SHORT_TEXT = 15;

/** The least normal double, below which two numbers of 15 significant digits can be one double. */
const LEAST_NORMAL = sql`2.2250738585072014e-308`;

/**
 * Whether a number's text is {@link SHORT_TEXT} characters or fewer, spelled without an exponent,
 * and it is a normal double or a zero. `JSON_EQUALS` finds `1e309` equal to `1E309`, which keep
 * their texts as {@link NumberKey}s, and finds `1` unequal to `1e0` where MariaDB 11.8 and 12.3 read
 * one side from a join buffer.
 */
function Short(value: Sql): Sql {
  return sql`(CHAR_LENGTH(${value}) <= ${int(SHORT_TEXT)} AND ${value} NOT REGEXP '[eE]' AND (ABS(CAST(JSON_VALUE(${value}, '$') AS DOUBLE)) >= ${LEAST_NORMAL} OR ${value} NOT REGEXP '[1-9]'))`;
}

/** The most digits a number spelled without an exponent holds below 10^308. */
const DIGITS_BELOW_GREATEST = 308;

/**
 * Whether a number's text can reach {@link PastDoubles}: it has an exponent, or more characters than
 * a number below 10^308 spelled without one holds. It spares the normalizing of every other text.
 */
function MayPassDoubles(text: Sql): Sql {
  return sql`(${text} REGEXP '[eE]' OR CHAR_LENGTH(${text}) > ${int(DIGITS_BELOW_GREATEST)})`;
}

/**
 * A normalized exponent past which `JSON_NORMALIZE` may have wrapped the exponent around a 64-bit
 * integer, as `0.5e-9223372036854775808` normalizes to `5.0E9223372036854775807`. A significand's
 * digits shift an exponent by fewer than 2^32, so a written exponent that wraps leaves the
 * normalized one past this in magnitude, and one that stays below it never wraps.
 */
const HUGE_EXPONENT = sql`9000000000000000000`;

/**
 * Whether a number is at least {@link GREATEST_SIGNIFICAND} times 10^308 in magnitude, for which
 * MariaDB's cast answers the greatest double, signed, and warns that it truncated the text, as it
 * does up to the first number that overflows. The normalized significand's leading digits are read
 * as a decimal, which holds them exactly. Where the normalized exponent passes
 * {@link HUGE_EXPONENT} and may have wrapped, the exponent `text` writes decides instead: a nonzero
 * number with a positive one is past the doubles, and one with a negative one casts to 0.
 */
function PastDoubles(normalized: Sql, text: Sql): Sql {
  const spelled = sql`CAST(${normalized} AS BINARY)`;
  const exponent = sql`CAST(SUBSTRING_INDEX(${spelled}, 'E', -1) AS DECIMAL(65, 0))`;
  const significand = sql`CAST(LEFT(TRIM(LEADING '-' FROM SUBSTRING_INDEX(${spelled}, 'E', 1)), ${int(SIGNIFICAND_CHARS)}) AS DECIMAL(20, 17))`;
  const written = sql`CAST(SUBSTRING_INDEX(LOWER(${text}), 'e', -1) AS DECIMAL(65, 0))`;
  const huge = sql`ABS(${exponent}) > ${HUGE_EXPONENT}`;
  const past = sql`(${exponent} > ${int(GREATEST_EXPONENT)} OR (${exponent} = ${int(GREATEST_EXPONENT)} AND ${significand} >= ${GREATEST_SIGNIFICAND}))`;
  return sql`(CASE WHEN ${huge} THEN ${written} > 0 AND ${significand} > 0 ELSE ${past} END)`;
}

/**
 * A JSON number's text in the one spelling of every number MySQL's JSON `=` finds it equal to. A
 * number's text is as written, `-0`, `0.0` and `1.0` included, and `JSON_TYPE` calls `15e-1` an
 * integer, so the text decides. An integer literal from -2^63 to 2^64 - 1 keeps its digits, which a
 * double would round past 2^53, with `-0` read as `0`; MySQL reads a longer one as a double. Any
 * other number is read as a double, as MySQL parses it: an integral one below 2^64 in magnitude as
 * the digits of its shortest decimal, which MySQL compares an integer with, so `1e19` meets
 * `10000000000000000000` and `18446744073709549568e0` meets `18446744073709550000`, and the rest as
 * the shortest text MariaDB writes for it. The cast caps a number beyond the doubles at the greatest
 * one, so a number that casts to it and whose `JSON_NORMALIZE` text has an exponent past 308, or an
 * integer literal of 309 digits or more, is that text, as `JSON_EQUALS` compares it, so `1e309`
 * meets `1E309` and `10e308`; a spelling of the greatest double itself with such an exponent, as
 * `0.17976931348623157e309`, is that double. The exponent is read as a decimal, which caps one past
 * a `SIGNED` above 308. A number {@link PastDoubles} is keyed with the greatest double, signed, which
 * the cast answers for it, so the cast never runs on it and never warns.
 */
function NumberKey(value: Sql): Sql {
  const text = sql`JSON_COMPACT(${value})`;
  const normalized = Normalized(value);
  const exponent = sql`CAST(SUBSTRING_INDEX(CAST(${normalized} AS BINARY), 'E', -1) AS DECIMAL(65, 0))`;
  const exact = sql`${text} REGEXP '^-?[0-9]{1,20}$' AND CAST(${text} AS DECIMAL(65, 0)) BETWEEN ${SIGNED_MIN} AND ${UNSIGNED_MAX}`;
  const keyed = (double: Sql) => {
    const integral = sql`${double} = FLOOR(${double}) AND ABS(${double}) < ${UNSIGNED_BOUND}`;
    const finite = sql`(ABS(${double}) < ${GREATEST_DOUBLE} OR ${exponent} <= ${int(GREATEST_EXPONENT)})`;
    const greatest = sql`${normalized} = ${Normalized(sql`CAST(${double} AS CHAR)`)}`;
    const beyond = sql`CONVERT(IF(${greatest}, ${double}, ${normalized}) USING utf8mb4) COLLATE ${ident(BINARY_COLLATION)}`;
    return sql`(CASE WHEN ${text} REGEXP '^-?[0-9]{309,}$' THEN ${beyond} WHEN ${integral} THEN CAST(${double} AS DECIMAL(20, 0)) WHEN ${finite} THEN ${double} ELSE ${beyond} END)`;
  };
  const greatestSigned = sql`IF(CAST(${normalized} AS BINARY) LIKE '-%', -${GREATEST_DOUBLE}, ${GREATEST_DOUBLE})`;
  return Json(
    sql`(CASE WHEN ${exact} THEN REGEXP_REPLACE(${text}, '^-0$', '0') WHEN ${MayPassDoubles(text)} AND ${PastDoubles(normalized, text)} THEN ${keyed(greatestSigned)} ELSE ${keyed(sql`CAST(JSON_VALUE(${value}, '$') AS DOUBLE)`)} END)`,
  );
}
