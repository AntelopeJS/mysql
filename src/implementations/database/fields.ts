import type {
  FieldType,
  SchemaDefinition,
  StringFieldType,
  TableDefinition,
} from "@antelopejs/interface-database/schema";

import { IsObject, IsString } from "./guards";
import { MysqlIdentifier } from "./identifier";
import { ID_COLUMN, INSTANCE_COLUMN, RESERVED_COLUMNS } from "./utils";
import {
  ArrayOf,
  BOOL,
  FLOAT,
  JsonOf,
  type KeyTypes,
  OPAQUE,
  type SqlType,
  TEXT,
  TIMESTAMP,
} from "./types";

type IoTsCodec = Exclude<FieldType, StringFieldType>;

export interface ParsedField {
  type: SqlType;
  codec?: IoTsCodec;
}

interface FieldSpec {
  column: string;
  type: SqlType;
  codec?: IoTsCodec;
}

export interface TableModel {
  fields: Record<string, FieldSpec>;
}

/**
 * The keys a row's document has of its own, in declaration order, which is not the column list.
 *
 * `_id` and `_instance` are prepended because neither is in `shape.fields` — the parser drops a
 * declaration of the first and refuses the second — and both are keys of the document all the
 * same. The names are logical rather than physical. The one owner of that expansion: the document
 * a row materializes into and the keys a write subtracts from an overflow document have to be the
 * same set, or a key is both stored in its column and left behind in `_extra`.
 *
 * `_instance` is a key a read *answers with* and never one a write assigns: it is what tells a
 * caller reading across instances which one each row came from.
 */
export function DocumentKeys(model: TableModel): string[] {
  return [ID_COLUMN, INSTANCE_COLUMN, ...Object.keys(model.fields)];
}

/**
 * The physical column order a row is stored in, given whatever the caller has for each part.
 *
 * The one owner of `[_id, _instance, …declared, _extra]`: the column definitions a table is
 * created with, the references a row-mode select list reads back, and the column list an insert
 * names all have to agree on both the set and the order. Generic so the same call assembles names,
 * compiled values and column plans; a fifth part is a compile error at every site.
 */
export function PhysicalOrder<T>(
  key: T,
  instance: T,
  declared: T[],
  extra: T,
): T[] {
  return [key, instance, ...declared, extra];
}

export interface SchemaModel {
  [tableId: string]: TableModel;
}

const SCALAR_TYPES = new Map<string, SqlType>([
  ["string", TEXT],
  ["number", FLOAT],
  ["boolean", BOOL],
  ["date", TIMESTAMP],
  ["object", OPAQUE],
  ["any", OPAQUE],
]);

const ARRAY_SUFFIX = "[]";
const SUPPORTED_TOKENS = [...SCALAR_TYPES.keys()].join(", ");

function IsCodec(
  value: Exclude<FieldType, string | StringFieldType[]>,
): value is IoTsCodec {
  return (
    "encode" in value &&
    typeof value.encode === "function" &&
    "decode" in value &&
    typeof value.decode === "function" &&
    "is" in value &&
    typeof value.is === "function"
  );
}

function UnsupportedFieldType(token: string, path: string): Error {
  return new Error(
    `Unsupported field type '${token}' for '${path}'. Supported: ${SUPPORTED_TOKENS}, optionally suffixed with [], a nested record, or an io-ts codec`,
  );
}

function ParseToken(token: string, path: string): SqlType {
  const normalized = token.trim().toLowerCase();
  if (normalized.endsWith(ARRAY_SUFFIX)) {
    return ArrayOf(ParseToken(normalized.slice(0, -ARRAY_SUFFIX.length), path));
  }
  const scalar = SCALAR_TYPES.get(normalized);
  if (!scalar) {
    throw UnsupportedFieldType(token, path);
  }
  return scalar;
}

function ParseKeyTypes(
  record: Record<string, StringFieldType>,
  path: string,
): KeyTypes {
  const keyTypes: Record<string, SqlType> = {};
  for (const [name, value] of Object.entries(record)) {
    keyTypes[name] = ParseFieldType(value, `${path}.${name}`).type;
  }
  return keyTypes;
}

export function ParseFieldType(field: FieldType, path: string): ParsedField {
  if (IsString(field)) {
    return { type: ParseToken(field, path) };
  }
  if (Array.isArray(field)) {
    if (field.length !== 1) {
      throw new Error(
        `Field '${path}' must declare exactly one element type, received ${field.length}`,
      );
    }
    return { type: ArrayOf(ParseFieldType(field[0], path).type) };
  }
  if (!IsObject(field)) {
    throw UnsupportedFieldType(String(field), path);
  }
  if (IsCodec(field)) {
    return { type: OPAQUE, codec: field };
  }
  return {
    type: JsonOf(ParseKeyTypes(field, path)),
  };
}

/**
 * Accepts a declared `_id`, which restates the key column rather than asking for a column.
 *
 * A schema that declares it is stating what the adapter already stores, so it is dropped from the
 * shape and the key column continues to serve it; {@link DocumentKeys} is what puts it back. Only
 * as the text the column is, though: any other declared type is a claim the adapter cannot honour.
 */
function AssertKeyRestated(declared: FieldType, path: string): void {
  const parsed = ParseFieldType(declared, `${path}.${ID_COLUMN}`);
  if (parsed.type.kind !== TEXT.kind || parsed.codec) {
    throw new Error(
      `Field '${ID_COLUMN}' on '${path}' restates the adapter's key column and must be declared 'string'`,
    );
  }
}

/**
 * Refuses a field whose column would be a reserved one. MySQL column names compare without case,
 * so `_Instance` is refused as `_instance` is, and only `_id` itself restates the key.
 */
function AssertDeclarable(name: string, path: string): void {
  const folded = name.toLowerCase();
  if (RESERVED_COLUMNS.includes(folded)) {
    throw new Error(
      `Field '${name}' on '${path}' uses a reserved column name (${RESERVED_COLUMNS.join(", ")}); column names compare without case`,
    );
  }
}

/**
 * Parses a table's fields into the columns that store them.
 *
 * Two fields that reach one column are refused: a long name is cut to fit MySQL's identifier
 * limit, and column names compare without case.
 */
export function ParseTable(table: TableDefinition, path: string): TableModel {
  const fields: Record<string, FieldSpec> = {};
  const owners = new Map<string, string>();
  for (const [name, declared] of Object.entries(table.fields ?? {})) {
    if (name === ID_COLUMN) {
      AssertKeyRestated(declared, path);
      continue;
    }
    AssertDeclarable(name, path);
    const column = MysqlIdentifier(name);
    const folded = column.toLowerCase();
    const owner = owners.get(folded);
    if (owner !== undefined) {
      throw new Error(
        `Fields '${owner}' and '${name}' on '${path}' both map to column '${column}'; rename one`,
      );
    }
    owners.set(folded, name);
    const parsed = ParseFieldType(declared, `${path}.${name}`);
    fields[name] = { column, type: parsed.type, codec: parsed.codec };
  }
  return { fields };
}

export function ParseSchema(
  schemaId: string,
  schema: SchemaDefinition,
): SchemaModel {
  const tables: SchemaModel = {};
  for (const [tableId, table] of Object.entries(schema)) {
    tables[tableId] = ParseTable(table, `${schemaId}.${tableId}`);
  }
  return tables;
}

/** The physical columns of the declared fields, in declaration order. */
export function DeclaredColumns(model: TableModel): string[] {
  return Object.values(model.fields).map((spec) => spec.column);
}
