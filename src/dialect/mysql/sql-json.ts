import type {
  DocumentMember,
  JsonKind,
  JsonSyntax,
  ScalarKind,
  Walk,
  WalkKind,
} from "../sql-types";
import type { KeyColumn } from "../../implementations/database/paths";
import type { Ordering } from "../../implementations/database/json";
import { type Sql, ident, int, join, lit, param, sql } from "../../statement";
import { type Flavour, type Held, HeldRead } from "./flavour";
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
const EMPTY_OBJECT = sql`JSON_OBJECT()`;

/** The JavaScript falsy values a JSON value can hold; `NaN` and `undefined` have no spelling. */
const FALSY = lit('[null, false, 0, ""]');

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

function Reads(flavour: Flavour): Record<ScalarKind, (value: Sql) => Sql> {
  const jsonTrue = flavour.json(lit("true"));
  return {
    text: (value) =>
      sql`(CASE WHEN ${Is(value, ["string"])} THEN ${Unquoted(value)} END)`,
    float: (value) =>
      sql`(CASE WHEN ${Is(value, ["number"])} THEN CAST(${value} AS DOUBLE) END)`,
    bool: (value) =>
      sql`(CASE WHEN ${Is(value, ["boolean"])} THEN (${value} = ${jsonTrue}) END)`,
    timestamp: (value) =>
      sql`(CASE WHEN ${Is(value, ["string"])} THEN ${ParseInstant(flavour, Unquoted(value))} END)`,
  };
}

/** MySQL's own order of JSON kinds, lowest first, as `ORDER BY` sorts a JSON column. */
const RANKS: Readonly<Record<JsonKind, number>> = {
  null: 0,
  number: 1,
  string: 2,
  object: 3,
  array: 4,
  boolean: 5,
};

/** The rank of the kinds a JSON column can hold that no JSON text spells, such as a `DATE`; MySQL sorts them last. */
const OTHER_RANK = 6;

/** A rank's tag is its one digit, so the tags of the ranks sort in the ranks' order. */
function Tagged(rank: number, text?: Sql): Sql {
  const tag = lit(String(rank));
  return text === undefined ? tag : sql`CONCAT(${tag}, ${text})`;
}

/**
 * The tag of the value's kind, followed by a string's text or an object's, an array's or another
 * value's canonical text; NULL for a null and an absent value.
 */
function RankedText(value: Sql): Sql {
  return sql`(CASE WHEN ${Is(value, ["string"])} THEN ${Tagged(RANKS.string, Unquoted(value))} WHEN ${Is(value, ["number"])} THEN ${Tagged(RANKS.number)} WHEN ${Is(value, ["boolean"])} THEN ${Tagged(RANKS.boolean)} WHEN ${Is(value, ["object"])} THEN ${Tagged(RANKS.object, sql`CAST(${value} AS CHAR)`)} WHEN ${Is(value, ["array"])} THEN ${Tagged(RANKS.array, sql`CAST(${value} AS CHAR)`)} WHEN ${Is(value, ["null"])} THEN NULL ELSE ${Tagged(OTHER_RANK, sql`CAST(${value} AS CHAR)`)} END)`;
}

/** A number, 0 or 1 for a boolean, 0 for any other value, and NULL for an absent one. */
function RankedNumber(value: Sql, jsonTrue: Sql): Sql {
  return sql`(CASE WHEN ${value} IS NULL THEN NULL WHEN ${Is(value, ["number"])} THEN CAST(${value} AS DOUBLE) WHEN ${Is(value, ["boolean"])} THEN (${value} = ${jsonTrue}) ELSE 0 END)`;
}

const ORDERINGS: Record<Ordering, Sql> = {
  "=": sql`=`,
  "<": sql`<`,
  "<=": sql`<=`,
  ">": sql`>`,
  ">=": sql`>=`,
};

/** The tag of a value's kind, then a string's text or a container's: what orders values of two kinds. */
function KindTagged(value: Sql): Sql {
  return sql`COALESCE(${RankedText(value)}, ${Tagged(RANKS.null)})`;
}

/**
 * Where the server compares JSON as text, equality is the flavour's and an ordering compares the
 * kind's tag and then the number, which is the order MySQL sorts JSON values in.
 */
function Comparison(flavour: Flavour): JsonSyntax["compare"] {
  const { jsonEquals } = flavour;
  if (!jsonEquals) {
    return (left, right, operator) =>
      sql`${left} ${ORDERINGS[operator]} ${right}`;
  }
  const jsonTrue = flavour.json(lit("true"));
  return (left, right, operator) => {
    const equal = jsonEquals(left, right);
    if (operator === "=") {
      return equal;
    }
    const inclusive = operator === "<=" || operator === ">=";
    const ranked = (value: Sql) =>
      sql`(${KindTagged(value)}, ${RankedNumber(value, jsonTrue)})`;
    return sql`(CASE WHEN ${equal} THEN ${inclusive ? sql`TRUE` : sql`FALSE`} ELSE ${ranked(left)} ${ORDERINGS[operator]} ${ranked(right)} END)`;
  };
}

function Ordered(flavour: Flavour): JsonSyntax["order"] {
  if (!flavour.jsonEquals) {
    return (value) => [value];
  }
  const jsonTrue = flavour.json(lit("true"));
  return (value) => [KindTagged(value), RankedNumber(value, jsonTrue)];
}

function Sameness(flavour: Flavour): JsonSyntax["same"] {
  const { jsonEquals } = flavour;
  if (!jsonEquals) {
    return (left, right) => sql`(${left} <=> ${right})`;
  }
  return (left, right) =>
    sql`(CASE WHEN ${left} IS NULL OR ${right} IS NULL THEN ${left} IS NULL AND ${right} IS NULL ELSE ${jsonEquals(left, right)} END)`;
}

/**
 * How a key column's source value reads as what the column holds: a declared string column's own
 * text, a JSON string, number or boolean by kind, and the two columns of a value key.
 */
function KeyReads(
  flavour: Flavour,
  reads: Record<ScalarKind, (value: Sql) => Sql>,
): Record<KeyColumn["read"], (value: Sql) => Sql> {
  const jsonTrue = flavour.json(lit("true"));
  return {
    text: (value) => value,
    string: reads.text,
    double: reads.float,
    bool: reads.bool,
    "ranked-text": RankedText,
    "ranked-number": (value) => RankedNumber(value, jsonTrue),
  };
}

/**
 * A boolean becomes a JSON boolean only when the server knows it is one, which a comparison says
 * and a stored `TINYINT(1)` does not.
 */
function Writings(flavour: Flavour): Record<ScalarKind, (value: Sql) => Sql> {
  return {
    text: (value) => flavour.json(sql`JSON_QUOTE(${value})`),
    float: (value) => flavour.number(value),
    bool: (value) => flavour.boolean(sql`(${value}) <> 0`),
    timestamp: (value) => flavour.json(sql`JSON_QUOTE(${IsoText(value)})`),
  };
}

function Entries(entries: readonly (readonly [string, Sql])[]): Sql {
  return join(
    entries.map(([name, value]) => sql`${lit(name)}, ${value}`),
    COMMA,
  );
}

function ObjectText(entries: readonly (readonly [string, Sql])[]): Sql {
  const members = entries.map(
    ([name, value]) =>
      sql`${lit(`${JSON.stringify(name)}:`)}, COALESCE(CAST(${value} AS CHAR), 'null')`,
  );
  return sql`CONCAT('{', ${join(members, sql`, ',', `)}, '}')`;
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

function WalkRows(
  flavour: Flavour,
  kind: WalkKind,
  source: Sql,
  alias: string,
): Walk {
  const rows = ident(alias);
  const from = WALK_ROWS[kind](source);
  return {
    from,
    ordinal: sql`${rows}.${ORDINAL}`,
    value: flavour.tabled(sql`${rows}.${VALUE}`),
    aggregate: (select, where) =>
      sql`(SELECT ${select} FROM ${from} AS ${rows}${where ? sql` WHERE ${where}` : sql``})`,
  };
}

/**
 * Each side is held once, so a merge chained N deep spells its operands once rather than 2^N times.
 * The keys of both go through one walk, the left's first, and each key is kept once: a left key
 * only where the right lacks it, since MariaDB's `JSON_OBJECTAGG` keeps a key it is given twice.
 * The guard is outside the aggregate, which answers a row over no input, so a side that is not an
 * object yields NULL and not `{}`.
 */
function ShallowMerge(
  flavour: Flavour,
  left: Sql,
  right: Sql,
  alias: string,
): Sql {
  const sides: readonly Held[] = [
    { name: "l", value: left, kind: "json" },
    { name: "r", value: right, kind: "json" },
  ];
  const [leftSide, rightSide] = sides.map((side) =>
    HeldRead(flavour, alias, side),
  );
  const keys = ident(`${alias}_k`);
  const name = sql`${keys}.${ident("name")}`;
  const path = DynamicPath(name);
  const fromRight = sql`(${keys}.${ORDINAL} > JSON_LENGTH(JSON_KEYS(${leftSide})))`;
  const value = sql`IF(${fromRight}, JSON_EXTRACT(${rightSide}, ${path}), JSON_EXTRACT(${leftSide}, ${path}))`;
  const kept = sql`${fromRight} OR NOT JSON_CONTAINS_PATH(${rightSide}, 'one', ${path})`;
  const names = sql`JSON_TABLE(JSON_MERGE_PRESERVE(JSON_KEYS(${leftSide}), JSON_KEYS(${rightSide})), '$[*]' COLUMNS (${ORDINAL} FOR ORDINALITY, ${ident("name")} LONGTEXT PATH '$')) AS ${keys}`;
  const merged = sql`(SELECT COALESCE(JSON_OBJECTAGG(${name}, ${value}), ${EMPTY_OBJECT}) FROM ${names} WHERE ${kept})`;
  const bothObjects = sql`${Is(leftSide, ["object"])} AND ${Is(rightSide, ["object"])}`;
  return sql`(SELECT CASE WHEN ${bothObjects} THEN ${merged} END FROM ${flavour.hold(sides)} AS ${ident(alias)})`;
}

/**
 * The server has no split, so the text is counted for its separators and cut once for each piece
 * by `SUBSTRING_INDEX`, which matches in the binary collation like every other comparison here. A
 * row per piece comes from walking a list as long as the count. An empty separator occurs nowhere,
 * so the whole text is the one piece.
 */
/** What a split is written with: the flavour, to hold the text, and the members it builds the array with. */
interface SplitSyntax extends Pick<JsonSyntax, "parse" | "of" | "collect"> {
  readonly flavour: Flavour;
}

function Split(
  json: SplitSyntax,
  text: Sql,
  separator: string,
  limit: number | undefined,
  alias: string,
): Sql {
  const held: Held = { name: "t", value: text, kind: "text" };
  const { flavour } = json;
  const whole = HeldRead(flavour, alias, held);
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
  const rows = sql`JSON_TABLE(${json.parse(sql`CONCAT('[', REPEAT('0,', ${occurrences}), '0]')`)}, '$[*]' COLUMNS (${ORDINAL} FOR ORDINALITY))`;
  const kept =
    limit === undefined ? sql`` : sql` WHERE ${ordinal} <= ${int(limit)}`;
  const array = json.collect(json.of(piece, "text"), ordinal, false);
  return sql`(SELECT CASE WHEN ${whole} IS NULL THEN NULL ELSE (SELECT ${array} FROM ${rows} AS ${pieces}${kept}) END FROM ${flavour.hold([held])} AS ${ident(alias)})`;
}

export function JsonOf(flavour: Flavour): JsonSyntax {
  const reads = Reads(flavour);
  const keyReads = KeyReads(flavour, reads);
  const writings = Writings(flavour);
  const text = (value: Sql) => sql`CAST(${value} AS CHAR)`;
  const parse = (value: Sql) => flavour.json(value);
  const of = (value: Sql, kind: ScalarKind) => writings[kind](value);
  const collect: JsonSyntax["collect"] = (element, ordinal, distinct) =>
    flavour.collect(element, ordinal, distinct, text);
  return {
    member: Member,
    dynamicMember: (document, key) =>
      sql`JSON_EXTRACT(${document}, ${DynamicPath(key)})`,
    is: Is,
    as: (value, kind) => reads[kind](value),
    key: (read, value) => keyReads[read](value),
    ranks: RANKS,
    tagged: Tagged,
    compare: Comparison(flavour),
    order: Ordered(flavour),
    same: Sameness(flavour),
    of,
    parse,
    text,
    null: flavour.json(lit("null")),
    emptyObject: EMPTY_OBJECT,
    emptyArray: sql`JSON_ARRAY()`,
    object: (entries) => sql`JSON_OBJECT(${Entries(entries)})`,
    objectText: ObjectText,
    array: (items) => sql`JSON_ARRAY(${join(items, COMMA)})`,
    document: Document,
    removeKeys: RemoveKeys,
    setKeys: SetKeys,
    hasKey: (document, key) =>
      sql`JSON_CONTAINS_PATH(${document}, 'one', ${KeyPath(key)})`,
    includes: (array, element) => flavour.includes(array, element),
    indexedElements: (column) => sql`JSON_EXTRACT(${column}, '$')`,
    truthy: (value) =>
      sql`(NOT ${flavour.includes(flavour.json(FALSY), value)})`,
    collect,
    inPlace: flavour.inPlace,
    length: (container) => sql`JSON_LENGTH(${container})`,
    at: At,
    concatArrays: (left, right) => sql`JSON_MERGE_PRESERVE(${left}, ${right})`,
    shallowMerge: (left, right, alias) =>
      ShallowMerge(flavour, left, right, alias),
    split: (value, separator, limit, alias) =>
      Split({ flavour, parse, of, collect }, value, separator, limit, alias),
    walk: (kind, source, alias) => WalkRows(flavour, kind, source, alias),
  };
}
