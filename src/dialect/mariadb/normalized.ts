import { type Sql, ident, lit, sql } from "../../statement";
import { BINARY_COLLATION } from "./json-text";

/** A JSON string literal, escapes included. */
const STRING = String.raw`"(?:[^"\\]++|\\.)*+"`;

/** The characters of JSON text that hold its scalars together, as the body of a character class. */
const STRUCTURE = String.raw`{}\[\]:,`;

/** A regular expression over JSON text and its replacement, which names groups as `\1` and up. */
interface Rewrite {
  readonly pattern: string;
  readonly into: string;
}

/**
 * Writes a container as the elements of an array that `JSON_NORMALIZE` keeps as written but for its
 * numbers. Each escape of a string is first spelled as the two characters it is, `\"` as `\\\"` and
 * `\u00e9` as `\\u00e9`, since MariaDB 12.3 rewrites escapes, so a string's backslashes then come in
 * pairs but for the one before an escaped `"`. Each run of {@link STRUCTURE} outside strings then
 * becomes a string of its characters after `\r`, between commas, which no string of the container
 * starts with: group 1 crosses whole strings and every other character up to the run, and `\G`
 * starts each match where the last one ended.
 */
const ENCODE: readonly Rewrite[] = [
  { pattern: String.raw`(\\)(["\\])|\\(.)`, into: String.raw`\\\\\1\2\3` },
  {
    pattern: String.raw`\G((?:[^"${STRUCTURE}]++|${STRING})*+)([${STRUCTURE}]++)`,
    into: String.raw`\1,"\\r\2",`,
  },
];

/**
 * Reads the array {@link ENCODE} writes back as the container, after `JSON_NORMALIZE`: each string
 * that starts with `\r`, with the commas and the array's own brackets beside it, as the characters
 * after the `\r`, and each escape as the character it spells. The `"` of a string's text is escaped,
 * and its backslashes come in pairs, so no such string starts or ends inside another, and a match
 * that starts at a backslash is an escape.
 */
const DECODE: readonly Rewrite[] = [
  {
    pattern: String.raw`\[?,?"\\r([${STRUCTURE}]++)",?\]?|\\(.)`,
    into: String.raw`\1\2`,
  },
];

/**
 * Text with each rewrite applied in turn, over its UTF-8 bytes: a MariaDB regular expression takes
 * time in the square of the length of text in a UTF-8 character set and in the length of bytes.
 * The patterns read only ASCII, which no byte of a longer UTF-8 character is.
 */
function Rewritten(text: Sql, rewrites: readonly Rewrite[]): Sql {
  const bytes = sql`CAST(CONVERT(${text} USING utf8mb4) AS BINARY)`;
  const rewritten = rewrites.reduce(
    (current, { pattern, into }) =>
      sql`REGEXP_REPLACE(${current}, ${lit(pattern)}, ${lit(into)})`,
    bytes,
  );
  return sql`CONVERT(${rewritten} USING utf8mb4) COLLATE ${ident(BINARY_COLLATION)}`;
}

/** Whether a JSON value is an array or an object. */
export function IsContainer(value: Sql): Sql {
  return sql`(JSON_TYPE(${value}) IN ('ARRAY', 'OBJECT'))`;
}

/**
 * A container's text with each nested number in the one spelling `JSON_NORMALIZE` writes, as
 * `1.0E0` for `1`, `1.0` and `1e0`, and everything else as written: its keys, their order, a
 * repeated key's members and its strings' escapes. `JSON_NORMALIZE` of the container itself sorts an
 * object's keys, and with them a repeated key's members, MariaDB 12.3 writes its keys back unescaped,
 * and 12.3 rewrites a string's escapes. The container's text starts and ends with a run of
 * {@link STRUCTURE}, so its encoding starts and ends with a comma, which the array leaves out. Text
 * without a `{` or an escape holds neither, so its own `JSON_NORMALIZE` text is the same, sooner.
 */
export function NormalizedContainer(value: Sql): Sql {
  const encoded = Rewritten(sql`JSON_COMPACT(${value})`, ENCODE);
  const array = sql`CONCAT('[', TRIM(BOTH ',' FROM ${encoded}), ']')`;
  const plain = sql`INSTR(${value}, '{') = 0 AND INSTR(${value}, CHAR(92)) = 0`;
  return sql`IF(${plain}, JSON_NORMALIZE(${value}), ${Rewritten(sql`JSON_NORMALIZE(${array})`, DECODE)})`;
}
