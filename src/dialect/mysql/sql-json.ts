import type {
  DocumentMember,
  JsonKind,
  JsonSyntax,
  ScalarKind,
  Walk,
  WalkKind,
} from "../sql-types";
import type { KeyColumn } from "../../implementations/database/paths";
import { type Sql, ident, int, join, lit, param, sql } from "../../statement";
import { IsoText, ParseInstant } from "./sql-time";

/** What `JSON_TYPE` answers for each kind; a JSON number has four. */
const TYPE_NAMES: Record<JsonKind, readonly string[]> = {
  object: ["OBJECT"],
  array: ["ARRAY"],
  string: ["STRING"],
  number: ["INTEGER", "UNSIGNED INTEGER", "DOUBLE", "DECIMAL"],
  boolean: ["BOOLEAN"],
  null: ["NULL"],
};

const COMMA = sql`, `;
const JSON_NULL = sql`CAST('null' AS JSON)`;
const JSON_TRUE = sql`CAST('true' AS JSON)`;
const EMPTY_OBJECT = sql`JSON_OBJECT()`;

/** The JavaScript falsy values a JSON value can hold; `NaN` and `undefined` have no spelling. */
const FALSY = sql`CAST('[null, false, 0, ""]' AS JSON)`;

/** A path through keys, each quoted so any key text is one member name. */
function KeyPath(...keys: readonly string[]): Sql {
  const members = keys.map(
    (key) => `."${key.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
  );
  return lit(`$${members.join("")}`);
}

/**
 * One `JSON_EXTRACT` for the whole path. A chain of one per key builds each intermediate value, a
 * subdocument for every key but the last, which the server then reads once more.
 */
function Member(document: Sql, ...keys: readonly string[]): Sql {
  if (keys.length === 0) {
    return document;
  }
  return sql`JSON_EXTRACT(${document}, ${KeyPath(...keys)})`;
}

/**
 * A type name as `JSON_TYPE` answers it. The server gives the text its JSON functions answer the
 * `utf8mb4_bin` collation, and a literal would otherwise take the session's, which cannot be
 * compared with it.
 */
function TypeLiteral(name: string): Sql {
  return sql`${lit(name)} COLLATE utf8mb4_bin`;
}

function Is(value: Sql, kinds: readonly JsonKind[]): Sql {
  const names = kinds.flatMap((kind) => TYPE_NAMES[kind]).map(TypeLiteral);
  return sql`(JSON_TYPE(${value}) IN (${join(names, COMMA)}))`;
}

/** Text out of JSON, in the session collation every other text carries. */
function Unquoted(value: Sql): Sql {
  return sql`CAST(JSON_UNQUOTE(${value}) AS CHAR)`;
}

const READS: Record<ScalarKind, (value: Sql) => Sql> = {
  text: (value) =>
    sql`(CASE WHEN ${Is(value, ["string"])} THEN ${Unquoted(value)} END)`,
  float: (value) =>
    sql`(CASE WHEN ${Is(value, ["number"])} THEN CAST(${value} AS DOUBLE) END)`,
  bool: (value) =>
    sql`(CASE WHEN ${Is(value, ["boolean"])} THEN (${value} = ${JSON_TRUE}) END)`,
  timestamp: (value) =>
    sql`(CASE WHEN ${Is(value, ["string"])} THEN ${ParseInstant(Unquoted(value))} END)`,
};

/**
 * How a key column's source value reads as what the column holds: a declared string column's own
 * text, a JSON string, number or boolean by kind, and any other JSON value as its canonical text.
 */
const KEY_READS: Record<KeyColumn["read"], (value: Sql) => Sql> = {
  text: (value) => value,
  string: READS.text,
  double: READS.float,
  bool: READS.bool,
  json: (value) => sql`CAST(${value} AS CHAR)`,
};

/**
 * A boolean becomes a JSON boolean only when the server knows it is one, which a comparison says
 * and a stored `TINYINT(1)` does not.
 */
const WRITINGS: Record<ScalarKind, (value: Sql) => Sql> = {
  text: (value) => sql`CAST(JSON_QUOTE(${value}) AS JSON)`,
  float: (value) => sql`CAST(${value} AS JSON)`,
  bool: (value) => sql`CAST((${value}) <> 0 AS JSON)`,
  timestamp: (value) => sql`CAST(JSON_QUOTE(${IsoText(value)}) AS JSON)`,
};

function Entries(entries: readonly (readonly [string, Sql])[]): Sql {
  return join(
    entries.map(([name, value]) => sql`${lit(name)}, ${value}`),
    COMMA,
  );
}

/**
 * A scalar member that is SQL NULL becomes a JSON null in `JSON_OBJECT`, which `JSON_MERGE_PATCH`
 * then drops. A JSON-backed member cannot go through that merge, since it recurses and would drop
 * the nulls inside it too, so each one is added by `JSON_MERGE_PRESERVE` when present: its keys are
 * disjoint from the others', so the merge is a union. The overflow loses the member names first, so
 * a key stored in both places reads as the member.
 */
function Document(members: readonly DocumentMember[], overflow?: Sql): Sql {
  const scalars = members.filter((member) => !member.container);
  const parts = [
    sql`JSON_MERGE_PATCH(${EMPTY_OBJECT}, JSON_OBJECT(${Entries(scalars.map((member) => [member.name, member.value]))}))`,
  ];
  for (const member of members.filter((one) => one.container)) {
    parts.push(
      sql`IF(${member.value} IS NULL, ${EMPTY_OBJECT}, JSON_OBJECT(${lit(member.name)}, ${member.value}))`,
    );
  }
  if (overflow) {
    parts.push(
      RemoveKeys(
        overflow,
        members.map((member) => member.name),
      ),
    );
  }
  if (parts.length === 1) {
    return parts[0];
  }
  return sql`JSON_MERGE_PRESERVE(${join(parts, COMMA)})`;
}

function RemoveKeys(document: Sql, keys: readonly string[]): Sql {
  if (keys.length === 0) {
    return document;
  }
  const paths = keys.map((key) => KeyPath(key));
  return sql`JSON_REMOVE(${document}, ${join(paths, COMMA)})`;
}

function SetKeys(
  document: Sql,
  entries: readonly (readonly [string, Sql])[],
): Sql {
  if (entries.length === 0) {
    return document;
  }
  const pairs = entries.map(([key, value]) => sql`${KeyPath(key)}, ${value}`);
  return sql`JSON_SET(${document}, ${join(pairs, COMMA)})`;
}

/**
 * `JSON_ARRAYAGG` takes no `ORDER BY`, so the array is concatenated from each element's JSON text.
 * `GROUP_CONCAT` skips SQL NULL, so an absent element is spelled as a JSON null; the session pins
 * `group_concat_max_len` high enough that no array is cut short.
 */
function Collect(element: Sql, order: Sql | undefined, distinct: boolean): Sql {
  const text = sql`COALESCE(CAST(${element} AS CHAR), 'null')`;
  const deduped = distinct ? sql`DISTINCT ${text}` : text;
  const ordered = order ? sql`${deduped} ORDER BY ${order}` : deduped;
  return sql`COALESCE(CAST(CONCAT('[', GROUP_CONCAT(${ordered} SEPARATOR ','), ']') AS JSON), JSON_ARRAY())`;
}

/** A path to the one key a statement computes, quoted as {@link KeyPath} quotes a static one. */
function DynamicPath(key: Sql): Sql {
  return sql`CONCAT('$.', CAST(JSON_QUOTE(${key}) AS CHAR))`;
}

/** The most an array position is clamped to either way, which no array reaches. */
const POSITION_LIMIT = 2147483647;

/**
 * `$[n]` counts from the start and `$[last-n]` from the end, so a negative position is the
 * distance from the end less one. The position is spelled in each branch.
 */
function At(array: Sql, position: Sql): Sql {
  const clamped = sql`LEAST(GREATEST(TRUNCATE(${position}, 0), ${int(-POSITION_LIMIT - 1)}), ${int(POSITION_LIMIT)})`;
  const index = sql`CAST(${clamped} AS SIGNED)`;
  const path = sql`CONCAT('$[', IF(${index} >= 0, CAST(${index} AS CHAR), CONCAT('last-', CAST(-1 - ${index} AS CHAR))), ']')`;
  return sql`JSON_EXTRACT(${array}, ${path})`;
}

const ORDINAL = ident("ord");
const VALUE = ident("value");
const WALK_COLUMNS = sql`COLUMNS (${ORDINAL} FOR ORDINALITY, ${VALUE} JSON PATH '$')`;

/**
 * An object's keys and its member values come from the server's own order of the object, which is
 * the same for both, so a walk of each lines up element for element.
 */
const WALK_ROWS: Record<WalkKind, (source: Sql) => Sql> = {
  elements: (source) => sql`JSON_TABLE(${source}, '$[*]' ${WALK_COLUMNS})`,
  keys: (source) =>
    sql`JSON_TABLE(JSON_KEYS(${source}), '$[*]' ${WALK_COLUMNS})`,
  members: (source) => sql`JSON_TABLE(${source}, '$.*' ${WALK_COLUMNS})`,
};

function WalkRows(kind: WalkKind, source: Sql, alias: string): Walk {
  const rows = ident(alias);
  return {
    ordinal: sql`${rows}.${ORDINAL}`,
    value: sql`${rows}.${VALUE}`,
    aggregate: (select, where) =>
      sql`(SELECT ${select} FROM ${WALK_ROWS[kind](source)} AS ${rows}${where ? sql` WHERE ${where}` : sql``})`,
  };
}

/**
 * Each side is held once on a derived table, so a merge chained N deep spells its operands once
 * rather than 2^N times. The keys of both go through one walk: a key in both rows reads the right's
 * value for each, and `JSON_OBJECTAGG` keeps the one. The guard is outside the aggregate, which
 * answers a row over no input, so a side that is not an object yields NULL and not `{}`.
 */
function ShallowMerge(left: Sql, right: Sql, alias: string): Sql {
  const held = ident(alias);
  const keys = ident(`${alias}_k`);
  const name = sql`${keys}.${ident("name")}`;
  const leftSide = sql`${held}.${ident("l")}`;
  const rightSide = sql`${held}.${ident("r")}`;
  const value = sql`IF(JSON_CONTAINS_PATH(${rightSide}, 'one', ${DynamicPath(name)}), JSON_EXTRACT(${rightSide}, ${DynamicPath(name)}), JSON_EXTRACT(${leftSide}, ${DynamicPath(name)}))`;
  const merged = sql`(SELECT COALESCE(JSON_OBJECTAGG(${name}, ${value}), ${EMPTY_OBJECT}) FROM JSON_TABLE(JSON_MERGE_PRESERVE(JSON_KEYS(${leftSide}), JSON_KEYS(${rightSide})), '$[*]' COLUMNS (${ident("name")} LONGTEXT PATH '$')) AS ${keys})`;
  const bothObjects = sql`${Is(leftSide, ["object"])} AND ${Is(rightSide, ["object"])}`;
  return sql`(SELECT CASE WHEN ${bothObjects} THEN ${merged} END FROM (SELECT ${left} AS ${ident("l")}, ${right} AS ${ident("r")}) AS ${held})`;
}

/**
 * The server has no split, so the text is counted for its separators and cut once for each piece
 * by `SUBSTRING_INDEX`, which matches in the binary collation like every other comparison here. A
 * row per piece comes from walking a list as long as the count. An empty separator occurs nowhere,
 * so the whole text is the one piece.
 */
function Split(
  text: Sql,
  separator: string,
  limit: number | undefined,
  alias: string,
): Sql {
  const held = ident(alias);
  const whole = sql`${held}.${ident("t")}`;
  const pieces = ident(`${alias}_p`);
  const ordinal = sql`${pieces}.${ORDINAL}`;
  const bound = param(separator);
  const occurrences =
    separator === ""
      ? sql`0`
      : sql`((CHAR_LENGTH(${whole}) - CHAR_LENGTH(REPLACE(${whole}, ${bound}, ''))) DIV ${int(Array.from(separator).length)})`;
  const piece =
    separator === ""
      ? whole
      : sql`SUBSTRING_INDEX(SUBSTRING_INDEX(${whole}, ${bound}, ${ordinal}), ${bound}, -1)`;
  const rows = sql`JSON_TABLE(CAST(CONCAT('[', REPEAT('0,', ${occurrences}), '0]') AS JSON), '$[*]' COLUMNS (${ORDINAL} FOR ORDINALITY))`;
  const kept =
    limit === undefined ? sql`` : sql` WHERE ${ordinal} <= ${int(limit)}`;
  const array = Collect(WRITINGS.text(piece), ordinal, false);
  return sql`(SELECT CASE WHEN ${whole} IS NULL THEN NULL ELSE (SELECT ${array} FROM ${rows} AS ${pieces}${kept}) END FROM (SELECT ${text} AS ${ident("t")}) AS ${held})`;
}

export const json: JsonSyntax = {
  member: Member,
  dynamicMember: (document, key) =>
    sql`JSON_EXTRACT(${document}, ${DynamicPath(key)})`,
  is: Is,
  as: (value, kind) => READS[kind](value),
  key: (read, value) => KEY_READS[read](value),
  of: (value, kind) => WRITINGS[kind](value),
  parse: (text) => sql`CAST(${text} AS JSON)`,
  text: (value) => sql`CAST(${value} AS CHAR)`,
  null: JSON_NULL,
  emptyObject: EMPTY_OBJECT,
  emptyArray: sql`JSON_ARRAY()`,
  object: (entries) => sql`JSON_OBJECT(${Entries(entries)})`,
  array: (items) => sql`JSON_ARRAY(${join(items, COMMA)})`,
  document: Document,
  removeKeys: RemoveKeys,
  setKeys: SetKeys,
  hasKey: (document, key) =>
    sql`JSON_CONTAINS_PATH(${document}, 'one', ${KeyPath(key)})`,
  includes: (array, element) => sql`(${element} MEMBER OF (${array}))`,
  indexedElements: (column) => sql`JSON_EXTRACT(${column}, '$')`,
  truthy: (value) => sql`(NOT (${value} MEMBER OF (${FALSY})))`,
  collect: Collect,
  length: (container) => sql`JSON_LENGTH(${container})`,
  at: At,
  concatArrays: (left, right) => sql`JSON_MERGE_PRESERVE(${left}, ${right})`,
  shallowMerge: ShallowMerge,
  split: Split,
  walk: WalkRows,
};
