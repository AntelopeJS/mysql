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
export type JsonPath = readonly string[];

/** What a declared index field names, resolved against the table's declaration. */
export type IndexTarget =
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
 * - `string`: the JSON string at a path; NULL for any other JSON type, so a string constant never
 *   matches a number.
 * - `double`, `bool`: the JSON number or boolean at a path.
 * - `json`: the canonical text of the JSON value at a path, or of the whole column.
 */
export type KeyRead = "text" | "string" | "double" | "bool" | "json";

type TextRead = Extract<KeyRead, "text" | "string" | "json">;
type ScalarRead = Exclude<KeyRead, TextRead>;

/**
 * How much of a text key column's value it holds.
 *
 * - `prefix`: `LEFT(value, width)`. A write never fails because of the index; a predicate served by
 *   the column rechecks the full value, and ordering is exact up to `width` characters.
 * - `exact`: the whole value, at most `width` characters. A unique index needs it to decide
 *   equality; a wider write fails and is reported with the field, the width and the index.
 */
export interface KeyFit {
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

export interface TextKeyColumn extends KeyColumnBase {
  readonly read: TextRead;
  readonly fit: KeyFit;
}

export interface ScalarKeyColumn extends KeyColumnBase {
  readonly read: ScalarRead;
}

/**
 * A VIRTUAL generated column an index keys on, derived from the declared indexes and nothing else.
 * The compiler names it, rather than relying on the server to recognise its expression, so an index
 * serves a read on every engine.
 */
export type KeyColumn = TextKeyColumn | ScalarKeyColumn;

/** One part of a physical index key, in key order. */
export type KeyPart =
  | { readonly kind: "instance"; readonly column: string }
  | { readonly kind: "stored"; readonly field: string; readonly column: string }
  | { readonly kind: "key"; readonly field: string; readonly key: KeyColumn }
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

/** How each declared field type is keyed when indexed whole: by its own column, or through a key column. */
const FIELD_KEYS: Record<
  SqlType["kind"],
  { readonly stored: number } | { readonly read: TextRead }
> = {
  text: { read: "text" },
  float: { stored: 8 },
  timestamp: { stored: 8 },
  bool: { stored: 1 },
  json: { read: "json" },
  array: { read: "json" },
};

/** How a JSON member is read for its declared type; an undeclared member is read as a string. */
const MEMBER_READS: Record<SqlType["kind"], KeyRead> = {
  text: "string",
  timestamp: "string",
  float: "double",
  bool: "bool",
  json: "json",
  array: "json",
};

const SCALAR_BYTES: Record<ScalarRead, number> = { double: 8, bool: 1 };

/** A key part before text widths are known: they depend on every other part of the index. */
type Draft =
  | { readonly kind: "stored"; readonly column: string; readonly bytes: number }
  | {
      readonly kind: "key";
      readonly source: string;
      readonly path: JsonPath;
      readonly read: KeyRead;
    };

function MemberType(
  type: SqlType,
  path: JsonPath,
  refuse: (owner: string) => Error,
): SqlType | undefined {
  let current = type;
  for (const [depth, segment] of path.entries()) {
    const keys = KeyTypesOf(current);
    if (!keys || !Object.hasOwn(keys, segment)) {
      return undefined;
    }
    current = keys[segment];
    if (!IsJsonBacked(current) && depth < path.length - 1) {
      throw refuse(path.slice(0, depth + 1).join(PATH_SEPARATOR));
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
export function ResolveIndexField(
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
  const refuse = (owner: string) =>
    new Error(
      `Index '${indexId}' keys on '${field}', but '${owner}' is declared as a value with no members`,
    );
  const spec = model.fields[head];
  if (!IsJsonBacked(spec.type)) {
    throw refuse(head);
  }
  return {
    kind: "member",
    column: spec.column,
    path: rest,
    type: MemberType(spec.type, rest, (owner) => refuse(`${head}.${owner}`)),
  };
}

function DraftOf(target: IndexTarget): Draft {
  if (target.kind === "id") {
    return { kind: "stored", column: ID_COLUMN, bytes: ID_BYTES };
  }
  if (target.kind === "member") {
    const read = target.type ? MEMBER_READS[target.type.kind] : "string";
    return { kind: "key", source: target.column, path: target.path, read };
  }
  const keyed = FIELD_KEYS[target.type.kind];
  if ("stored" in keyed) {
    return { kind: "stored", column: target.column, bytes: keyed.stored };
  }
  return { kind: "key", source: target.column, path: [], read: keyed.read };
}

function IsTextRead(read: KeyRead): read is TextRead {
  return read === "text" || read === "string" || read === "json";
}

function DraftBytes(draft: Draft): number {
  if (draft.kind === "stored") {
    return draft.bytes;
  }
  return IsTextRead(draft.read) ? 0 : SCALAR_BYTES[draft.read];
}

function KeyColumnOf(
  draft: Extract<Draft, { kind: "key" }>,
  fit: KeyFit,
): KeyColumn {
  const { source, path, read } = draft;
  const words = source === EXTRA_COLUMN ? path : [source, ...path];
  const located = `${source}:${JSON.stringify(path)}`;
  if (!IsTextRead(read)) {
    const definition = `${SIGNATURE_PREFIX}:${read}:${located}`;
    const name = KeyColumnName(words, definition);
    return { name, source, path, read, definition };
  }
  const definition = `${SIGNATURE_PREFIX}:${read}:${fit.kind}:${fit.width}:${located}`;
  const name = KeyColumnName(words, definition);
  return { name, source, path, read, fit, definition };
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
  const textParts = drafts.filter(
    (draft) => draft.kind === "key" && IsTextRead(draft.read),
  ).length;
  const remaining = session.keyBudgetBytes - INSTANCE_BYTES - fixed;
  const width = Math.floor(remaining / BYTES_PER_CHAR / Math.max(textParts, 1));
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
  return drafts.map((draft, position) => {
    const field = fields[position];
    if (draft.kind === "stored") {
      return { kind: "stored", field, column: draft.column };
    }
    return { kind: "key", field, key: KeyColumnOf(draft, fit) };
  });
}
