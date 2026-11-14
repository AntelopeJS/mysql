import { type Sql, ident, int, lit, sql } from "../../statement";
import { BINARY_COLLATION } from "./json-text";

/** A JSON string literal, escapes included. */
const STRING = String.raw`"(?:[^"\\]++|\\.)*+"`;

/** The characters of JSON text that hold its scalars together, as the body of a character class. */
const STRUCTURE = String.raw`{}\[\]:,`;

/**
 * Text that may spell a number of more than 15 digits or one with an exponent. It is read over the
 * text strings included, so a string can only send a container the longer way.
 */
const LONG_OR_EXPONENT = String.raw`[0-9][eE]|[0-9](?:\.?[0-9]){15}`;

/**
 * A regular expression over JSON text and its replacement, which names groups as `\1` and up. Group
 * 1 holds the text before the match: it crosses whole strings and every character that cannot start
 * the match, and `\G` starts each match where the last one ended.
 */
interface Rewrite {
  readonly pattern: string;
  readonly into: string;
}

/**
 * Each number of JSON text spelled by its value: a zero as `0`, sign and fraction dropped, and any
 * other number without the zeros that end its fraction, so `12.50` as `12.5` and `12.0` as `12`.
 * That is the text MariaDB writes for the double of a number of at most 15 digits and no exponent,
 * and the digits of such an integer, which is the number's {@link ContainerKey} spelling.
 */
const SHORT_NUMBERS: Rewrite = {
  pattern: String.raw`\G((?:[^"0-9-]++|${STRING})*+)(?:-?(0)(?:\.0++)?(?![0-9.])|(-?)(0|[1-9][0-9]*+)(\.[0-9]*[1-9])?(?:\.?0*+))`,
  into: String.raw`\1\2\3\4\5`,
};

/**
 * Each run of {@link STRUCTURE} outside strings written as a one-string array between commas, so a
 * container becomes a flat array of its scalars and those arrays, which no scalar is.
 */
const FLATTENED: Rewrite = {
  pattern: String.raw`\G((?:[^"${STRUCTURE}]++|${STRING})*+)([${STRUCTURE}]++)`,
  into: String.raw`\1,["\2"],`,
};

/**
 * The most bytes the array {@link FLATTENED} writes takes per byte of a container's text: a run of
 * {@link STRUCTURE} grows at most 7 times.
 */
const GROWTH = 7;

/**
 * The most backslashes a container's text may hold to be rewritten. A rewrite that crosses a string
 * takes a step of MariaDB's regular expression match limit for each escape, and fails, answering
 * NULL, past about 1.5 million escapes that each follow a character, as in `"x\"x\"`. They are
 * counted by a regular expression, since `REPLACE` takes time in the square of their number.
 */
const MOST_ESCAPES = 1_000_000;

/**
 * Text with a rewrite applied over its UTF-8 bytes: a MariaDB regular expression takes time in the
 * square of the length of text in a UTF-8 character set and in the length of bytes. The patterns
 * read only ASCII, which no byte of a longer UTF-8 character is.
 */
function Rewritten(text: Sql, { pattern, into }: Rewrite): Sql {
  const bytes = sql`CAST(CONVERT(${text} USING utf8mb4) AS BINARY)`;
  return sql`CONVERT(REGEXP_REPLACE(${bytes}, ${lit(pattern)}, ${lit(into)}) USING utf8mb4) COLLATE ${ident(BINARY_COLLATION)}`;
}

/** Whether a JSON value is an array or an object. */
export function IsContainer(value: Sql): Sql {
  return sql`(JSON_TYPE(${value}) IN ('ARRAY', 'OBJECT'))`;
}

/** Whether a container's text spells only numbers of at most 15 digits and no exponent. */
export function ShortNumbered(value: Sql): Sql {
  return sql`(CAST(CONVERT(${value} USING utf8mb4) AS BINARY) NOT REGEXP ${lit(LONG_OR_EXPONENT)})`;
}

/**
 * The container's text with each number {@link FLATTENED} and read back one element at a time: a
 * number as its `key`, a run as its characters, and a string or a literal as written. Each element
 * is copied before it is read, as a `JSON_TABLE` column is read past its text by `JSON_NORMALIZE`.
 */
function ElementKeys(compact: Sql, key: (number: Sql) => Sql): Sql {
  const array = sql`CONCAT('[', TRIM(BOTH ',' FROM ${Rewritten(compact, FLATTENED)}), ']')`;
  const [ordinal, column] = [
    ident("ajs_element_ordinal"),
    ident("ajs_element"),
  ];
  const element = sql`CONCAT(${column}, '')`;
  const read = sql`(CASE JSON_TYPE(${element}) WHEN 'ARRAY' THEN JSON_VALUE(${element}, '$[0]') WHEN 'INTEGER' THEN ${key(element)} WHEN 'DOUBLE' THEN ${key(element)} ELSE ${element} END)`;
  return sql`(SELECT GROUP_CONCAT(CONVERT(${read} USING utf8mb4) ORDER BY ${ordinal} SEPARATOR '') FROM JSON_TABLE(${array}, '$[*]' COLUMNS (${ordinal} FOR ORDINALITY, ${column} JSON PATH '$')) AS ${ident("ajs_elements")})`;
}

/**
 * A container's compact text with each nested number spelled by `key`, a number's dedup key, and
 * everything else as written: its keys, their order, a repeated key's members and its strings'
 * escapes. A {@link ShortNumbered} container is rewritten by {@link SHORT_NUMBERS} alone, and any
 * other one element by element. MariaDB answers NULL for text longer than `max_allowed_packet` and
 * for a regular expression past its match limit, so a container whose array could be longer, or
 * whose text holds more than {@link MOST_ESCAPES} backslashes, keeps its compact text as written.
 */
export function ContainerKey(value: Sql, key: (number: Sql) => Sql): Sql {
  const compact = sql`JSON_COMPACT(${value})`;
  const escapes = sql`LENGTH(REGEXP_REPLACE(CAST(CONVERT(${value} USING utf8mb4) AS BINARY), ${lit(String.raw`[^\\]++`)}, ''))`;
  const fits = sql`LENGTH(${value}) * ${int(GROWTH)} <= @@max_allowed_packet`;
  return sql`(CASE WHEN ${escapes} > ${int(MOST_ESCAPES)} THEN ${compact} WHEN ${ShortNumbered(value)} THEN ${Rewritten(compact, SHORT_NUMBERS)} WHEN ${fits} THEN ${ElementKeys(compact, key)} ELSE ${compact} END)`;
}
