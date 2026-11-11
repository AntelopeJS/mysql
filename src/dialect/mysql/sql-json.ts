import type {
  DocumentMember,
  JsonKind,
  JsonSyntax,
  ScalarKind,
} from "../sql-types";
import { type Sql, join, lit, sql } from "../../statement";
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

/** A path to one key, quoted so any key text is one member name. */
function KeyPath(key: string): Sql {
  const escaped = key.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return lit(`$."${escaped}"`);
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
  return sql`JSON_REMOVE(${document}, ${join(keys.map(KeyPath), COMMA)})`;
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

export const json: JsonSyntax = {
  member: (document, key) => sql`JSON_EXTRACT(${document}, ${KeyPath(key)})`,
  dynamicMember: (document, key) =>
    sql`JSON_EXTRACT(${document}, CONCAT('$.', JSON_QUOTE(${key})))`,
  is: Is,
  as: (value, kind) => READS[kind](value),
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
  truthy: (value) => sql`(NOT (${value} MEMBER OF (${FALSY})))`,
  collect: Collect,
};
