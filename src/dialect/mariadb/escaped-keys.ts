import type { EscapedKeys, MemberPath } from "../mysql";
import { Bind, type Sql, ident, join, lit, sql } from "../../statement";
import { BINARY_COLLATION, Json } from "./json-text";

/** A backslash, which every escaped key is spelled with. */
const BACKSLASH = lit("\\");

/** Keys of ASCII letters, digits and `_`, which no common JSON writer escapes on its own. */
const PLAIN_CHARACTERS = "A-Za-z0-9_";
const PLAIN_KEY = new RegExp(`^[${PLAIN_CHARACTERS}]*$`);

/** What `JSON_SEARCH` reads as a wildcard or as its escape, each escaped by a backslash. */
const SEARCH_SPECIAL = /[\\%_]/g;

/** Whether every key of the path is plain, so that its spelling is the one the document holds. */
function IsPlain({ holder, key }: MemberPath): boolean {
  return [...holder, key].every((one) => PLAIN_KEY.test(one));
}

/**
 * Whether a key the statement computes holds a character {@link PLAIN_KEY} leaves out. The test
 * looks for one such character rather than anchoring the whole key, since MariaDB's `$` also
 * matches before a final line feed.
 */
function NotPlain(key: Sql): Sql {
  return sql`(${key} REGEXP ${lit(`[^${PLAIN_CHARACTERS}]`)})`;
}

/** A computed key as a `JSON_SEARCH` pattern matching the key alone, escaped as {@link SEARCH_SPECIAL} says. */
function SearchPattern(key: Sql): Sql {
  return Array.from("\\%_").reduce(
    (pattern, special) =>
      sql`REPLACE(${pattern}, ${lit(special)}, ${lit(`\\${special}`)})`,
    key,
  );
}

/**
 * A path the decoding functions read as the keys themselves. Each member is JSON text, so a control
 * character is an escape there: a raw one makes `JSON_EXISTS` and `JSON_QUERY` answer NULL.
 */
function DecodedPath(keys: readonly string[]): Sql {
  return lit(`$${keys.map((key) => `.${JSON.stringify(key)}`).join("")}`);
}

/**
 * Whether the document holds the member at the decoding `path` under another spelling of it.
 * `JSON_EXISTS` decodes a key and `JSON_EXTRACT` does not. A document without a backslash spells
 * every key as it reads; a byte search tells, where a `LIKE` or a search in the text's collation
 * costs more than the read.
 */
function HeldEscaped(document: Sql, path: Sql): Sql {
  return sql`(LOCATE(${BACKSLASH}, CAST(${document} AS BINARY)) > 0 AND JSON_EXISTS(${document}, ${path}))`;
}

/**
 * The member of an object by its key as the object spells it. `JSON_SEARCH` finds the key's position
 * among the object's keys, which it decodes, and `$.*` lists the object's members in that same
 * order. It matches in the session's binary collation; in a case-insensitive one it would match `FR`
 * for `fr`.
 */
function SpelledMember(object: Sql, pattern: Sql): Sql {
  const position = sql`JSON_UNQUOTE(JSON_SEARCH(JSON_KEYS(${object}), 'one', ${pattern}))`;
  return sql`JSON_EXTRACT(JSON_EXTRACT(${object}, '$.*'), ${position})`;
}

/** A column of a table, as a generated key column reads its source. */
const COLUMN_REFERENCE = /^(?:`(?:[^`]|``)+`\.)?`(?:[^`]|``)+`$/;

const HELD_DOCUMENT = ident("__escaped_key");
const HELD_COLUMN = ident("d");
const HELD_KEY = ident("__computed_key");
const KEY_COLUMN = ident("k");

/**
 * `read` of the document: in place where it is a column, which a generated column reads and which is
 * cheap to repeat, and otherwise over the document parsed once, as `wrap` takes the read. A read of a
 * read, which a `default()` between two keys makes, then spells each document once rather than once
 * per use. The document's text keeps the spelling of its keys, and its column answers in
 * `utf8mb4_bin`.
 */
function OnDocument(
  document: Sql,
  read: (held: Sql) => Sql,
  wrap: (held: Sql) => Sql = (held) => held,
): Sql {
  if (COLUMN_REFERENCE.test(Bind(document).sql)) {
    return read(document);
  }
  const held = sql`JSON_TABLE(${document}, '$' COLUMNS (${HELD_COLUMN} JSON PATH '$')) AS ${HELD_DOCUMENT}`;
  return wrap(
    sql`(SELECT ${read(sql`${HELD_DOCUMENT}.${HELD_COLUMN}`)} FROM ${held})`,
  );
}

/**
 * MariaDB matches a path's key to a document's as each is spelled, so `$."café"` misses a key
 * stored as `"caf\u00e9"`. A read that misses looks for such a spelling only where the document
 * holds one, and only for a key a writer escapes: a plain key reads as it is spelled, so `"f\u0072"`
 * is not read as `fr`.
 *
 * A computed key is held once in a one-row table, so its text appears once however often the read
 * uses it, and a key computed by a read of a computed key grows the statement no faster than before.
 * A document itself read through a computed key is held beside the key, so a chain of such reads
 * spells each document once.
 */
export const ESCAPED_KEYS: EscapedKeys = {
  member: (member, read) => {
    if (IsPlain(member)) {
      return read(member.document);
    }
    const { holder, key } = member;
    const path = DecodedPath([...holder, key]);
    const pattern = lit(key.replace(SEARCH_SPECIAL, "\\$&"));
    const spelled = (held: Sql) => {
      const object =
        holder.length === 0
          ? held
          : sql`JSON_QUERY(${held}, ${DecodedPath(holder)})`;
      return sql`COALESCE(${read(held)}, IF(${HeldEscaped(held, path)}, ${SpelledMember(object, pattern)}, NULL))`;
    };
    return OnDocument(member.document, spelled, Json);
  },
  has: (member, found) => {
    if (IsPlain(member)) {
      return found(member.document);
    }
    const path = DecodedPath([...member.holder, member.key]);
    return OnDocument(
      member.document,
      (held) => sql`(${found(held)} OR ${HeldEscaped(held, path)})`,
    );
  },
  computed: (document, key, path) => {
    const name = sql`${HELD_KEY}.${KEY_COLUMN}`;
    const tables = [
      sql`JSON_TABLE(JSON_QUOTE(${key}), '$' COLUMNS (${KEY_COLUMN} LONGTEXT COLLATE ${ident(BINARY_COLLATION)} PATH '$')) AS ${HELD_KEY}`,
    ];
    const chained = Bind(document).sql.includes(Bind(HELD_KEY).sql);
    if (chained) {
      tables.push(
        sql`JSON_TABLE(${document}, '$' COLUMNS (${HELD_COLUMN} JSON PATH '$')) AS ${HELD_DOCUMENT}`,
      );
    }
    const source = chained ? sql`${HELD_DOCUMENT}.${HELD_COLUMN}` : document;
    const spelled = OnDocument(
      source,
      (held) =>
        sql`IF(${HeldEscaped(held, path(name))}, ${SpelledMember(held, SearchPattern(name))}, NULL)`,
      Json,
    );
    const read = sql`COALESCE(JSON_EXTRACT(${source}, ${path(name)}), IF(${NotPlain(name)}, ${spelled}, NULL))`;
    return sql`(SELECT ${read} FROM ${join(tables, sql`, `)})`;
  },
};
