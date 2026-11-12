import type { SessionSyntax } from "../../dialect";
import type { TableModel } from "./fields";
import { KeyColumnName } from "./identifier";
import { IsJsonBacked, KeyTypesOf, type SqlType } from "./types";
import {
  EXTRA_COLUMN,
  ID_COLUMN,
  MAX_INSTANCE_ID_CHARS,
  MAX_KEY_CHARS,
  RESERVED_COLUMNS,
} from "./utils";

/** A path below a JSON column: `["fr"]` under `title`, `["_internal", "data", "owner"]` under `_extra`. */
type JsonPath = readonly string[];

/** What a declared index field names, resolved against the table's declaration. */
type IndexTarget =
  | { readonly kind: "id" }
  | {
      readonly kind: "field";
      readonly column: string;
      readonly type: SqlType;
    }
  | {
      readonly kind: "member";
      readonly column: string;
      readonly path: JsonPath;
      /** The declared type at the path, when the declaration reaches that far. */
      readonly type?: SqlType;
    };

/**
 * How a generated key column reads its source.
 *
 * - `text`: a declared string column's own text.
 * - `string`: the JSON string at a path declared a string or a date; NULL for any other JSON type,
 *   so a string constant never matches a number.
 * - `double`, `bool`: the JSON number or boolean at a path declared one.
 * - `ranked-text`, `ranked-number`: the two columns of a {@link ValueKey}.
 */
type KeyRead =
  | "text"
  | "string"
  | "double"
  | "bool"
  | "ranked-text"
  | "ranked-number";

type TextRead = Extract<KeyRead, "text" | "string" | "ranked-text">;
type ScalarRead = Exclude<KeyRead, TextRead>;

/** The reads a value of a declared scalar type is keyed by. */
type TypedRead = Extract<KeyRead, "text" | "string" | "double" | "bool">;

/**
 * How much of a text key column's value it holds.
 *
 * - `prefix`: `LEFT(value, width)`. A write never fails because of the index; a predicate served by
 *   the column rechecks the full value, and ordering is exact up to `width` characters.
 * - `exact`: the whole value, at most `width` characters. A unique index needs it to decide
 *   equality; a wider write fails and is reported with the field, the width and the index.
 */
interface KeyFit {
  readonly kind: "prefix" | "exact";
  readonly width: number;
}

interface KeyColumnBase {
  readonly name: string;
  /** The physical column it reads: a declared column, or `_extra`. */
  readonly source: string;
  /** Where below the source it reads; empty for the whole column. */
  readonly path: JsonPath;
  /** Everything the column's definition depends on; stored as its signature, and digested into its name. */
  readonly definition: string;
}

interface TextKeyColumn extends KeyColumnBase {
  readonly read: TextRead;
  readonly fit: KeyFit;
}

interface ScalarKeyColumn extends KeyColumnBase {
  readonly read: ScalarRead;
}

/**
 * A VIRTUAL generated column an index keys on, derived from the declared indexes and nothing else.
 * The compiler names it, rather than relying on the server to recognise its expression, so an index
 * serves a read on every engine.
 */
export type KeyColumn = TextKeyColumn | ScalarKeyColumn;

/**
 * The key of a value whose type nothing declares, as two columns in key order that sort it as the
 * engine sorts JSON: on MySQL absent first, then null, numbers, strings, objects, arrays, and
 * booleans, false before true.
 *
 * - `text`: a tag for the value's kind, its place in that order, followed by a string's text or an
 *   object's or an array's JSON text; the tag alone for a number or a boolean; NULL for a null or an
 *   absent value.
 * - `number`: a number, or 0 and 1 for false and true; 0 for any other value, a null included, and
 *   NULL for an absent value, which is what sorts an absent value before a null.
 *
 * A unique index over the two refuses two equal values of any kind, and never two nulls.
 */
export interface ValueKey {
  readonly text: TextKeyColumn;
  readonly number: ScalarKeyColumn;
}

/** One part of a physical index key, in key order. */
export type KeyPart =
  | { readonly kind: "instance"; readonly column: string }
  | { readonly kind: "stored"; readonly field: string; readonly column: string }
  | { readonly kind: "key"; readonly field: string; readonly key: KeyColumn }
  | { readonly kind: "value"; readonly field: string; readonly key: ValueKey }
  | {
      readonly kind: "elements";
      readonly field: string;
      readonly column: string;
      readonly elem: SqlType;
    };

const PATH_SEPARATOR = ".";
const SIGNATURE_PREFIX = "antelopejs:1:key";

/** Bytes a utf8mb4 character may take in an index key. */
const BYTES_PER_CHAR = 4;
const INSTANCE_BYTES = MAX_INSTANCE_ID_CHARS * BYTES_PER_CHAR;
const ID_BYTES = MAX_KEY_CHARS * BYTES_PER_CHAR;

/** A value keyed by its kind as well as its value, which is how every JSON value without a scalar declared type is keyed. */
const VALUE = "value";

/** How each declared field type is keyed when indexed whole: by its own column, or through key columns. */
const FIELD_KEYS: Record<
  SqlType["kind"],
  { readonly stored: number } | { readonly read: "text" } | typeof VALUE
> = {
  text: { read: "text" },
  float: { stored: 8 },
  timestamp: { stored: 8 },
  bool: { stored: 1 },
  json: VALUE,
  array: VALUE,
};

/** How a JSON member is keyed for its declared type; a member no declaration types is a value. */
const MEMBER_READS: Record<SqlType["kind"], TypedRead | typeof VALUE> = {
  text: "string",
  timestamp: "string",
  float: "double",
  bool: "bool",
  json: VALUE,
  array: VALUE,
};

const SCALAR_BYTES: Record<ScalarRead, number> = {
  double: 8,
  bool: 1,
  "ranked-number": 8,
};

/** What a value key's columns take of the key budget beside its text. */
const VALUE_BYTES = SCALAR_BYTES["ranked-number"];

/** A key part before text widths are known: they depend on every other part of the index. */
type Draft =
  | { readonly kind: "stored"; readonly column: string; readonly bytes: number }
  | {
      readonly kind: "key";
      readonly source: string;
      readonly path: JsonPath;
      readonly read: TypedRead;
    }
  | {
      readonly kind: "value";
      readonly source: string;
      readonly path: JsonPath;
    };

/** Whether a column's comment is a key column's signature, which makes the column the module's own. */
export function IsKeyColumnSignature(comment: string): boolean {
  return comment.startsWith(`${SIGNATURE_PREFIX}:`);
}

function NoMembers(indexId: string, field: string, owner: string): Error {
  return new Error(
    `Index '${indexId}' keys on '${field}', but '${owner}' is declared as a value with no members`,
  );
}

/** The declared type at `path` below `type`, or nothing once the declaration stops saying. */
function MemberType(
  indexId: string,
  field: string,
  type: SqlType,
  path: JsonPath,
): SqlType | undefined {
  let current = type;
  for (const [depth, segment] of path.entries()) {
    const keys = KeyTypesOf(current);
    if (!keys || !Object.hasOwn(keys, segment)) {
      return undefined;
    }
    current = keys[segment];
    if (!IsJsonBacked(current) && depth < path.length - 1) {
      const owner = field.split(PATH_SEPARATOR).slice(0, depth + 2);
      throw NoMembers(indexId, field, owner.join(PATH_SEPARATOR));
    }
  }
  return current;
}

/**
 * Resolves an index field: `_id`, a declared field by its exact name, or a path.
 *
 * A dotted name that is not a declared field is a path. Its first segment is either a declared JSON
 * field, and the rest reads below it, or undeclared, and the whole name reads below `_extra`. The
 * PostgreSQL module reads such a name as one undeclared key instead; here `title.fr` and
 * `_internal.data.owner` are nested paths an index can serve.
 */
function ResolveIndexField(
  indexId: string,
  field: string,
  model: TableModel,
): IndexTarget {
  if (field === ID_COLUMN) {
    return { kind: "id" };
  }
  if (Object.hasOwn(model.fields, field)) {
    const spec = model.fields[field];
    return { kind: "field", column: spec.column, type: spec.type };
  }
  const [head, ...rest] = field.split(PATH_SEPARATOR);
  if (RESERVED_COLUMNS.includes(head.toLowerCase())) {
    throw new Error(
      `Index '${indexId}' keys on '${field}', which reads the reserved column '${head}' the adapter owns; index a declared field instead`,
    );
  }
  if (!Object.hasOwn(model.fields, head)) {
    return { kind: "member", column: EXTRA_COLUMN, path: [head, ...rest] };
  }
  const spec = model.fields[head];
  if (!IsJsonBacked(spec.type)) {
    throw NoMembers(indexId, field, head);
  }
  return {
    kind: "member",
    column: spec.column,
    path: rest,
    type: MemberType(indexId, field, spec.type, rest),
  };
}

function DraftOf(target: IndexTarget): Draft {
  if (target.kind === "id") {
    return { kind: "stored", column: ID_COLUMN, bytes: ID_BYTES };
  }
  if (target.kind === "member") {
    const read = target.type ? MEMBER_READS[target.type.kind] : VALUE;
    return read === VALUE
      ? { kind: "value", source: target.column, path: target.path }
      : { kind: "key", source: target.column, path: target.path, read };
  }
  const keyed = FIELD_KEYS[target.type.kind];
  if (keyed === VALUE) {
    return { kind: "value", source: target.column, path: [] };
  }
  if ("stored" in keyed) {
    return { kind: "stored", column: target.column, bytes: keyed.stored };
  }
  return { kind: "key", source: target.column, path: [], read: keyed.read };
}

function IsTextRead(read: KeyRead): read is TextRead {
  return read === "text" || read === "string" || read === "ranked-text";
}

/** The key bytes a part takes before its text: all of a fixed-width part, and none of a text part. */
function DraftBytes(draft: Draft): number {
  switch (draft.kind) {
    case "stored":
      return draft.bytes;
    case "value":
      return VALUE_BYTES;
    case "key":
      return IsTextRead(draft.read) ? 0 : SCALAR_BYTES[draft.read];
  }
}

function HasText(draft: Draft): boolean {
  return (
    draft.kind === "value" || (draft.kind === "key" && IsTextRead(draft.read))
  );
}

/** The name and the signature of a key column, from everything its definition depends on. */
function Named(source: string, path: JsonPath, signature: string) {
  const words = source === EXTRA_COLUMN ? path : [source, ...path];
  const definition = `${SIGNATURE_PREFIX}:${signature}:${source}:${JSON.stringify(path)}`;
  return { name: KeyColumnName(words, definition), definition };
}

function ScalarColumnOf(
  source: string,
  path: JsonPath,
  read: ScalarRead,
): ScalarKeyColumn {
  return { ...Named(source, path, read), source, path, read };
}

function TextColumnOf(
  source: string,
  path: JsonPath,
  read: TextRead,
  fit: KeyFit,
): TextKeyColumn {
  const signature = `${read}:${fit.kind}:${fit.width}`;
  return { ...Named(source, path, signature), source, path, read, fit };
}

function KeyColumnOf(
  draft: Extract<Draft, { kind: "key" }>,
  fit: KeyFit,
): KeyColumn {
  const { source, path, read } = draft;
  return IsTextRead(read)
    ? TextColumnOf(source, path, read, fit)
    : ScalarColumnOf(source, path, read);
}

function ValueKeyOf(
  draft: Extract<Draft, { kind: "value" }>,
  fit: KeyFit,
): ValueKey {
  const { source, path } = draft;
  return {
    text: TextColumnOf(source, path, "ranked-text", fit),
    number: ScalarColumnOf(source, path, "ranked-number"),
  };
}

/** The characters a value key's text column spends on the tag of the value's kind, ahead of its text. */
const TAG_CHARS = 1;

/** How many characters of a value a key column holds, for a column that holds text. */
export function TextCapacity(key: KeyColumn): number | undefined {
  if (!("fit" in key)) {
    return undefined;
  }
  return key.read === "ranked-text" ? key.fit.width - TAG_CHARS : key.fit.width;
}

/** The key columns a part of an index reads, in key order: none for a part that is a stored column. */
export function KeyColumnsOf(part: KeyPart): KeyColumn[] {
  switch (part.kind) {
    case "key":
      return [part.key];
    case "value":
      return [part.key.text, part.key.number];
    default:
      return [];
  }
}

/**
 * The text width each text part of an index gets, from the engine's key budget.
 *
 * The key leads with `_instance`; the fixed-width parts take their bytes; what remains is split
 * evenly between the text parts at four bytes a character. More text parts make each narrower,
 * never refused, until no character is left.
 */
function TextWidth(
  indexId: string,
  drafts: readonly Draft[],
  session: SessionSyntax,
): number {
  const fixed = drafts.reduce((sum, draft) => sum + DraftBytes(draft), 0);
  const textParts = drafts.filter(HasText).length;
  const remaining = session.keyBudgetBytes - INSTANCE_BYTES - fixed;
  const width =
    textParts === 0 ? 0 : Math.floor(remaining / BYTES_PER_CHAR / textParts);
  if (remaining < 0 || (textParts > 0 && width < 1)) {
    throw new Error(
      `Index '${indexId}' needs ${INSTANCE_BYTES} bytes for the instance and ${fixed} for its fixed-width fields, which leaves ${remaining} of the ${session.keyBudgetBytes}-byte key for ${textParts} text field(s); drop a field from the index`,
    );
  }
  return width;
}

/**
 * The key parts of a btree index over `fields`, `_instance` excluded: stored columns where a field
 * is one, key columns everywhere else, text key columns sized from the key budget.
 */
export function KeyParts(
  indexId: string,
  fields: readonly string[],
  unique: boolean,
  model: TableModel,
  session: SessionSyntax,
): KeyPart[] {
  const drafts = fields.map((field) =>
    DraftOf(ResolveIndexField(indexId, field, model)),
  );
  const fit: KeyFit = {
    kind: unique ? "exact" : "prefix",
    width: TextWidth(indexId, drafts, session),
  };
  return drafts.map((draft, position): KeyPart => {
    const field = fields[position];
    switch (draft.kind) {
      case "stored":
        return { kind: "stored", field, column: draft.column };
      case "value":
        return { kind: "value", field, key: ValueKeyOf(draft, fit) };
      case "key":
        return { kind: "key", field, key: KeyColumnOf(draft, fit) };
    }
  });
}
