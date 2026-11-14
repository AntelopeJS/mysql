import {
  type EscapedKeys,
  type Flavour,
  type Held,
  type MemberPath,
  FamilyDialect,
  UnsignedZeros,
} from "../mysql";
import type { CollectedRows, HashRow, HeldKeys, HeldTexts } from "../sql-types";
import { Bind, type Sql, ident, int, join, lit, sql } from "../../statement";
import { CATALOG } from "./catalog";
import { MAX_KEY_CHARS } from "../../implementations/database/utils";

const BINARY_COLLATION = "utf8mb4_nopad_bin";

/**
 * The largest `group_concat_max_len`. MariaDB builds `JSON_ARRAYAGG` and `JSON_OBJECTAGG` on its
 * group concatenation, which truncates an aggregate at this many bytes.
 */
const UNBOUNDED_AGGREGATE_BYTES = 4294967295;

/**
 * The bytes of a value MariaDB sorts by, past which it sorts two values as equal: the longest `_id`
 * at four bytes per character, so that a sort by identity orders every row of a table apart.
 */
const ID_SORT_BYTES = MAX_KEY_CHARS * 4;

/** MariaDB's statement timeout, in seconds, which a fraction of a second refines. */
const MS_PER_SECOND = 1000;

/**
 * MariaDB 11.8's JSON functions refuse a document of 32 nested containers, and its `json_valid`
 * check with them; 12.3 nests deeper, and the lower limit holds on both.
 */
const MAX_JSON_NESTING = 31;

/** A statement that writes, changes or locks a table, which MySQL's read timeout never bounds. */
const WRITES =
  /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|RENAME|LOCK)\b/i;

/**
 * `max_statement_time` bounds every statement, so a write lifts it for itself and stays as unbounded
 * as it is on MySQL, whose `max_execution_time` bounds `SELECT` alone.
 */
function Uncapped(statement: Sql): Sql {
  return WRITES.test(Bind(statement).sql)
    ? sql`SET STATEMENT max_statement_time = 0 FOR ${statement}`
    : statement;
}

/** `max_statement_time` stopped a statement. */
const STATEMENT_TIMEOUT = 1969;

const OFFSET_CHARS = 6;
const ZONE_OFFSET = lit(`[+-][0-9]{2}:[0-9]{2}$`);
const UTC_DESIGNATOR = /Z$/;

/**
 * Text as a JSON value. MariaDB stores a document as text and has no JSON type to cast to, but the
 * text a JSON function answers is JSON to every other JSON function. The text is taken into the
 * session's collation first: `JSON_QUOTE` answers in another one, which `JSON_OBJECT` refuses to
 * mix with the key beside it.
 */
function Json(text: Sql): Sql {
  return sql`JSON_EXTRACT(CONVERT(${text} USING utf8mb4) COLLATE ${ident(BINARY_COLLATION)}, '$')`;
}

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
const ESCAPED_KEYS: EscapedKeys = {
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

/**
 * Equality as JSON: a number however it is spelled, an object whatever its key order. `JSON_EQUALS`
 * is compared with 1 rather than read as a truth, which MariaDB 11.8 and 12.3 take to hold where it
 * is SQL NULL, in a `WHERE` and a `CASE` alike.
 */
function JsonEquals(left: Sql, right: Sql): Sql {
  return sql`(JSON_EQUALS(${left}, ${right}) = 1)`;
}

/**
 * `JSON_EQUALS` holds where the two values normalize to the same text, so that text's CRC-32, in
 * one character set whatever the value's, is shared by every pair it holds for.
 */
function JsonHash(value: Sql): Sql {
  return sql`CRC32(CONVERT(JSON_NORMALIZE(${value}) USING utf8mb4))`;
}

/**
 * A JSON value, or SQL NULL where it is the JSON `null`. MariaDB compares a JSON string by its
 * unquoted text, where `"null"` equals the JSON `null`, so the value is compared as bytes and read
 * back as JSON. It is compacted first: MariaDB keeps the text a client wrote to a JSON column,
 * whitespace around a `null` included.
 */
function Present(value: Sql): Sql {
  return Json(PresentText(value));
}

/** The compacted text of {@link Present}, SQL NULL where the value is absent. */
function PresentText(value: Sql): Sql {
  return sql`NULLIF(CAST(JSON_COMPACT(${value}) AS BINARY), 'null')`;
}

/**
 * Whether one element of the array equals the element as JSON does. `JSON_CONTAINS` would also
 * find it inside a nested array or object, and MariaDB has no `MEMBER OF`. The element goes through
 * `JSON_ARRAY` so a scalar and a JSON value both arrive as JSON. A value that is not an array holds
 * only itself, as MySQL's `MEMBER OF` reads it.
 */
function Includes(array: Sql, element: Sql): Sql {
  const member = ident("__member");
  const value = ident("value");
  const sought = sql`JSON_EXTRACT(JSON_ARRAY(${element}), '$[0]')`;
  const elements = sql`JSON_TABLE(${array}, '$[*]' COLUMNS (${value} JSON PATH '$')) AS ${member}`;
  const found = sql`EXISTS (SELECT 1 FROM ${elements} WHERE ${JsonEquals(sql`${member}.${value}`, sought)})`;
  const itself = JsonEquals(array, sought);
  return sql`(CASE WHEN ${array} IS NULL OR ${element} IS NULL THEN NULL WHEN JSON_TYPE(${array}) = 'ARRAY' THEN ${found} ELSE ${itself} END)`;
}

/**
 * MariaDB writes a negative zero as `0`, so one is spelled `-0`, which JSON text keeps; `ATAN2`
 * tells it from a positive zero, which compares equal to it.
 */
function JsonNumber(value: Sql): Sql {
  return Json(
    sql`IF(${value} = 0 AND ATAN2(${value}, -1) < 0, '-0', ${value})`,
  );
}

/**
 * `JSON_ARRAYAGG` takes an order on MariaDB. A dedup keeps one element per text and one absent
 * element, apart from a JSON null, as MySQL's does; MariaDB keeps an object's keys in the order they
 * were written, so two objects that differ only in that order are both kept.
 */
function Collect(
  element: Sql,
  ordinal: Sql | undefined,
  distinct: boolean,
): Sql {
  if (distinct) {
    return sql`COALESCE(JSON_ARRAYAGG(DISTINCT ${element}), JSON_ARRAY())`;
  }
  const order = ordinal === undefined ? sql`` : sql` ORDER BY ${ordinal}`;
  return sql`COALESCE(JSON_ARRAYAGG(${element}${order}), JSON_ARRAY())`;
}

/**
 * The offsets MySQL's cast takes, in minutes east of UTC, `-00:00` excepted; it reads any other as no
 * instant.
 */
const EARLIEST_OFFSET_MINUTES = -840;
const NEGATIVE_ZERO_OFFSET = lit("-00:00");
const LATEST_OFFSET_MINUTES = 840;
const MINUTES_PER_HOUR = 60;

/** The largest row count, which stands for none where an offset needs one. */
const NO_LIMIT = sql`18446744073709551615`;

/**
 * MariaDB's `JSON_ARRAYAGG` takes a dedup, an order and a `LIMIT`, so a nested query is aggregated in
 * the select that reads the outer row rather than in a derived table, which MariaDB cannot correlate.
 * A dedup keeps one element per text and one absent element, apart from a JSON null, as a dedup at
 * the top does.
 */
function CollectInPlace(element: Sql, rows: CollectedRows): Sql {
  const value = rows.distinct ? sql`DISTINCT ${element}` : element;
  const order = rows.order ? sql` ORDER BY ${rows.order}` : sql``;
  const bounded = rows.offset !== undefined || rows.count !== undefined;
  const count = rows.count === undefined ? NO_LIMIT : int(rows.count);
  const limit = bounded
    ? sql` LIMIT ${int(rows.offset ?? 0)}, ${count}`
    : sql``;
  return sql`COALESCE(JSON_ARRAYAGG(${value}${order}${limit}), JSON_ARRAY())`;
}

/** MariaDB stores JSON as text, and a dedup compares that text in the binary collation. */
function DedupText(json: Sql): Sql {
  return sql`CONVERT(${json} USING utf8mb4) COLLATE ${ident(BINARY_COLLATION)}`;
}

/** A text's CRC-32, which MariaDB can key where it cannot key the `LONGTEXT` a JSON text is. */
function Hash(text: Sql): Sql {
  return sql`CRC32(COALESCE(${text}, ''))`;
}

const HASH_COLUMN = ident("h");

/**
 * A `JSON_TABLE` of one element. MariaDB keys a derived table joined after it on its `'$[*]'`
 * column, and keys none for a `'$'` row path.
 */
function OneHash(text: Sql, alias: string): HashRow {
  return {
    from: sql`JSON_TABLE(JSON_ARRAY(${Hash(text)}), '$[*]' COLUMNS (${HASH_COLUMN} INT UNSIGNED PATH '$'))`,
    hash: sql`${ident(alias)}.${HASH_COLUMN}`,
  };
}

/** MariaDB merges a derived table into the query that reads it unless the table has a `LIMIT`. */
function Materialized(select: Sql): Sql {
  return sql`${select} LIMIT ${NO_LIMIT}`;
}

function HashedKey(hash: Sql, key: readonly Sql[]): Sql {
  return sql`JSON_ARRAY(${join([hash, ...key], sql`, `)})`;
}

/**
 * The most bytes an element spends beyond its quoted key parts: its brackets, a CRC-32 of up to
 * 10 digits, and the separator before each key part and after the element.
 */
const HASHED_KEY_BYTES = 14;
const KEY_PART_BYTES = 2;

/** The brackets of the held array and of the one-row array that holds it. */
const HELD_ARRAY_BYTES = 4;

/**
 * Each element's length is bounded from its key parts, as `JSON_ARRAY` quotes them, rather than
 * measured, which would hash every row's key text once more.
 */
function HeldFits(key: readonly Sql[]): Sql {
  const quoted = key.map((part) => sql`LENGTH(JSON_QUOTE(${part}))`);
  const element = sql`${join(quoted, sql` + `)} + ${int(HASHED_KEY_BYTES + KEY_PART_BYTES * key.length)}`;
  return sql`(SUM(${element}) + ${int(HELD_ARRAY_BYTES)} <= @@max_allowed_packet)`;
}

const HELD_KEYS = ident("held");

function KeyPart(part: number): Sql {
  return ident(`k${part}`);
}

/**
 * The array is read from the one-row table's column as it is, where the walk of a JSON value reads
 * it through `JSON_EXTRACT`, which parses it again for each select that reads it.
 */
function HeldArray(array: Sql, parts: number, alias: string): HeldKeys {
  const held = sql`${ident(alias)}.${HELD_KEYS}`;
  const keys = Array.from({ length: parts }, (_, part) => part);
  const columns = join(
    [
      sql`${HASH_COLUMN} INT UNSIGNED PATH '$[0]'`,
      ...keys.map(
        (part) =>
          sql`${KeyPart(part)} LONGTEXT COLLATE ${ident(BINARY_COLLATION)} PATH ${lit(`$[${part + 1}]`)}`,
      ),
    ],
    sql`, `,
  );
  return {
    from: sql`JSON_TABLE(JSON_ARRAY(${array}), '$[*]' COLUMNS (${HELD_KEYS} JSON PATH '$'))`,
    rows: (at) => ({
      from: sql`JSON_TABLE(${held}, '$[*]' COLUMNS (${columns}))`,
      hash: sql`${ident(at)}.${HASH_COLUMN}`,
      key: keys.map((part) => sql`${ident(at)}.${KeyPart(part)}`),
    }),
  };
}

/**
 * MariaDB's cast reads a zone offset and drops it, so the offset is subtracted from the local time,
 * and a `Z` is dropped since the session is UTC. `CONVERT_TZ` would leave an instant before 1970
 * unshifted.
 */
function Instant(text: Sql): Sql {
  const local = sql`CAST(LEFT(${text}, CHAR_LENGTH(${text}) - ${int(OFFSET_CHARS)}) AS DATETIME(6))`;
  const offset = sql`RIGHT(${text}, ${int(OFFSET_CHARS)})`;
  const hours = sql`CAST(SUBSTRING(${offset}, 2, 2) AS SIGNED)`;
  const minutes = sql`CAST(SUBSTRING(${offset}, 5, 2) AS SIGNED)`;
  const east = sql`(IF(LEFT(${offset}, 1) = '-', -1, 1) * (${hours} * ${int(MINUTES_PER_HOUR)} + ${minutes}))`;
  const valid = sql`${minutes} < ${int(MINUTES_PER_HOUR)} AND ${east} BETWEEN ${int(EARLIEST_OFFSET_MINUTES)} AND ${int(LATEST_OFFSET_MINUTES)} AND ${offset} <> ${NEGATIVE_ZERO_OFFSET}`;
  const shifted = sql`(CASE WHEN ${valid} THEN TIMESTAMPADD(MINUTE, -${east}, ${local}) END)`;
  return sql`(CASE WHEN ${text} REGEXP ${ZONE_OFFSET} THEN ${shifted} ELSE CAST(REPLACE(${text}, 'Z', '') AS DATETIME(6)) END)`;
}

/**
 * The values go into one JSON array, which `JSON_TABLE` reads back as the table's one row: MariaDB
 * reads an outer column inside `JSON_TABLE` but not inside a derived table.
 */
function Hold(columns: readonly Held[]): Sql {
  const values = join(
    columns.map((held) => held.value),
    sql`, `,
  );
  const definitions = columns.map((held, position) => {
    const type =
      held.kind === "json"
        ? sql`JSON`
        : sql`LONGTEXT COLLATE utf8mb4_nopad_bin`;
    return sql`${ident(held.name)} ${type} PATH ${lit(`$[${position}]`)}`;
  });
  return sql`JSON_TABLE(JSON_ARRAY(${values}), '$' COLUMNS (${join(definitions, sql`, `)}))`;
}

/**
 * The texts of a JSON array of `parts` texts, or of each such array a JSON array holds, read back
 * in the binary collation a table's columns compare in.
 */
function TextColumns(
  array: Sql,
  rows: "$" | "$[*]",
  parts: number,
  alias: string,
): HeldTexts {
  const names = Array.from({ length: parts }, (_, part) => ident(`e${part}`));
  const definitions = names.map(
    (name, part) =>
      sql`${name} LONGTEXT COLLATE ${ident(BINARY_COLLATION)} PATH ${lit(`$[${part}]`)}`,
  );
  return {
    from: sql`JSON_TABLE(COALESCE(${array}, JSON_ARRAY()), ${lit(rows)} COLUMNS (${join(definitions, sql`, `)}))`,
    columns: names.map((name) => sql`${ident(alias)}.${name}`),
  };
}

/** MariaDB 11.8 LTS and 12.3 LTS. */
const MARIADB: Flavour = {
  id: "mariadb",
  name: "MariaDB",
  binaryCollation: BINARY_COLLATION,
  jsonType: sql`JSON COLLATE utf8mb4_nopad_bin`,
  maxJsonNesting: MAX_JSON_NESTING,
  tooDeepErrno: 4040,
  warnsTooDeep: true,
  heldNesting: 1,
  multiValuedIndex: false,
  pinned: [
    sql`group_concat_max_len = ${int(UNBOUNDED_AGGREGATE_BYTES)}`,
    sql`max_sort_length = ${int(ID_SORT_BYTES)}`,
  ],
  readTimeout: (ms) =>
    sql`max_statement_time = ${int(ms)} / ${int(MS_PER_SECOND)}`,
  uncapped: Uncapped,
  readTimeoutErrnos: [STATEMENT_TIMEOUT],
  checkViolation: {
    errno: 4025,
    named: /^CONSTRAINT `((?:[^`]|``)*)` failed for /,
  },
  jsonEquals: JsonEquals,
  json: Json,
  escapedKeys: ESCAPED_KEYS,
  present: Present,
  absent: (value) => sql`(${PresentText(value)} IS NULL)`,
  value: (document, path) => sql`JSON_VALUE(${document}, ${path})`,
  valueIsRead: false,
  number: JsonNumber,
  unsignedZero: (value) => Json(UnsignedZeros(value, "\\")),
  keepsInText: (value) => !Object.is(value, -0),
  boolean: (truth) =>
    sql`(CASE ${truth} WHEN TRUE THEN ${Json(lit("true"))} WHEN FALSE THEN ${Json(lit("false"))} END)`,
  includes: Includes,
  collect: Collect,
  inPlace: {
    collect: CollectInPlace,
    dedupText: DedupText,
    hash: Hash,
    hashRow: OneHash,
    materialized: Materialized,
    hashedKey: HashedKey,
    held: HeldArray,
    heldFits: HeldFits,
    heldTexts: (array, parts, alias) => TextColumns(array, "$", parts, alias),
    heldElements: (array, parts, alias) =>
      TextColumns(array, "$[*]", parts, alias),
  },
  returning: true,
  lateral: false,
  nestedLoopJoin: { jsonHash: JsonHash },
  hold: Hold,
  holdBare: (held) =>
    sql`JSON_TABLE(${held.value}, '$' COLUMNS (${ident(held.name)} JSON PATH '$'))`,
  tabled: Json,
  instant: Instant,
  instantText: (date) =>
    date.toISOString().replace("T", " ").replace(UTC_DESIGNATOR, ""),
  matches: (text, pattern) => sql`(${text} REGEXP CONCAT('(?-i)', ${pattern}))`,
  captured: (group) => `\\${group}`,
  ...CATALOG,
};

/** MariaDB 11.8 LTS and 12.3 LTS. */
export const mariadb = FamilyDialect(MARIADB);
