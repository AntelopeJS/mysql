import { type Sql, ident, sql } from "../../statement";

/** The binary collation MariaDB compares JSON text in. */
export const BINARY_COLLATION = "utf8mb4_nopad_bin";

/**
 * Text as a JSON value. MariaDB stores a document as text and has no JSON type to cast to, but the
 * text a JSON function answers is JSON to every other JSON function. The text is taken into the
 * session's collation first: `JSON_QUOTE` answers in another one, which `JSON_OBJECT` refuses to
 * mix with the key beside it.
 */
export function Json(text: Sql): Sql {
  return sql`JSON_EXTRACT(CONVERT(${text} USING utf8mb4) COLLATE ${ident(BINARY_COLLATION)}, '$')`;
}
