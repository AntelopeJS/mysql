import { createHash } from "node:crypto";

import { MAX_IDENTIFIER_CHARS } from "../../statement";

const DIGEST_CHARS = 8;
const DIGEST_SEPARATOR = "_";
const KEPT_CHARS =
  MAX_IDENTIFIER_CHARS - DIGEST_CHARS - DIGEST_SEPARATOR.length;
const TABLE_SEPARATOR = "__";
const CROSS_INSTANCE_INDEX_SUFFIX = "__g";
const KEY_COLUMN_PREFIX = "__k_";
const KEY_COLUMN_READABLE_CHARS =
  MAX_IDENTIFIER_CHARS -
  KEY_COLUMN_PREFIX.length -
  DIGEST_SEPARATOR.length -
  DIGEST_CHARS;
const PRIMARY_KEY_NAME = "primary";
const UNREADABLE = /[^\p{L}\p{N}_]/gu;

function Digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, DIGEST_CHARS);
}

/**
 * Fits an arbitrary name into MySQL's 64-character identifier limit.
 *
 * Names that fit are returned verbatim so the physical layout stays readable; longer ones keep
 * their first 55 characters, then `_` and 8 hex digits of the SHA-256 of the full name, which
 * keeps the mapping deterministic and injective in practice. MySQL counts characters, not bytes.
 */
export function MysqlIdentifier(name: string): string {
  const characters = Array.from(name);
  if (characters.length <= MAX_IDENTIFIER_CHARS) {
    return name;
  }
  return `${characters.slice(0, KEPT_CHARS).join("")}${DIGEST_SEPARATOR}${Digest(name)}`;
}

/**
 * The physical table of a schema's table: every schema shares the connected database, so the
 * schema id becomes part of the name, after the configured prefix.
 */
export function TableName(
  prefix: string,
  schemaId: string,
  tableId: string,
): string {
  return MysqlIdentifier(`${prefix}${schemaId}${TABLE_SEPARATOR}${tableId}`);
}

/**
 * The physical name of a declared index. Index names are per table in MySQL, so the index id is
 * the name; an id that reads as `PRIMARY`, which only the primary key may use, is suffixed.
 */
export function IndexName(indexId: string): string {
  const name = MysqlIdentifier(indexId);
  if (name.toLowerCase() !== PRIMARY_KEY_NAME) {
    return name;
  }
  return `${name}${DIGEST_SEPARATOR}${Digest(indexId)}`;
}

/** The unprefixed twin a `crossInstance` index also gets. */
export function CrossInstanceIndexName(indexId: string): string {
  return MysqlIdentifier(`${indexId}${CROSS_INSTANCE_INDEX_SUFFIX}`);
}

/**
 * The name of a generated key column: `__k_`, the readable words of what it reads, and a digest of
 * its whole definition, so two definitions never share a name and one definition always gets the
 * same one.
 */
export function KeyColumnName(
  words: readonly string[],
  definition: string,
): string {
  const readable = Array.from(words.join("_").replace(UNREADABLE, "_"))
    .slice(0, KEY_COLUMN_READABLE_CHARS)
    .join("");
  return `${KEY_COLUMN_PREFIX}${readable}${DIGEST_SEPARATOR}${Digest(definition)}`;
}
