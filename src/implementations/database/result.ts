import type { Row } from "../../connection";
import type { TableModel } from "./fields";
import type { SqlType } from "./types";
import {
  DEFAULT_INSTANCE_ID,
  EXTRA_COLUMN,
  ID_COLUMN,
  INSTANCE_COLUMN,
} from "./utils";
import { IsBoolean, IsDocument, IsNumber, IsString } from "./guards";

/** A decoded value: JSON's values, and a `Date` revived where the type declares one. */
export type RowValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | RowValue[]
  | RowObject;

/** A JSON object keyed by member, or a document keyed by field. */
export interface RowObject {
  [name: string]: RowValue;
}

/** A cell as the driver hands it over: JSON, instants and integers arrive as text. */
type Cell = ReturnType<Row["get"]>;

/** What `JSON.parse` yields: the values JSON spells, and nothing else. */
function IsParsed(value: unknown): value is RowValue {
  if (
    value === null ||
    IsString(value) ||
    IsNumber(value) ||
    IsBoolean(value)
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(IsParsed);
  }
  return IsDocument(value) && Object.values(value).every(IsParsed);
}

function ParseJson(text: string): RowValue {
  const parsed: unknown = JSON.parse(text);
  if (!IsParsed(parsed)) {
    throw new Error("A JSON column held a value JSON cannot spell");
  }
  return parsed;
}

/** `DATETIME(6)` as the driver spells it, in the session's UTC. */
const STORED_INSTANT = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,6})?$/;

/** The instant a text spells: a stored instant in UTC, or anything `new Date` reads. */
function InstantOf(text: string): Date {
  const stored = STORED_INSTANT.exec(text);
  if (!stored) {
    return new Date(text);
  }
  const fraction = (stored[3] ?? ".000").slice(0, 4).padEnd(4, "0");
  return new Date(`${stored[1]}T${stored[2]}${fraction}Z`);
}

function ReviveTimestamp(value: RowValue): RowValue {
  if (value instanceof Date || !IsString(value)) {
    return value;
  }
  const date = InstantOf(value);
  return Number.isNaN(date.getTime()) ? value : date;
}

/** Revives the instants a type declares inside a value already decoded. */
export function ReviveValue(value: RowValue, type: SqlType): RowValue {
  if (value === null || value === undefined) {
    return value;
  }
  switch (type.kind) {
    case "timestamp":
      return ReviveTimestamp(value);
    case "array":
      return Array.isArray(value)
        ? value.map((item) => ReviveValue(item, type.elem))
        : value;
    case "json": {
      if (!type.keys || !IsDocument(value)) {
        return value;
      }
      const result = { ...value };
      for (const name of Object.keys(type.keys)) {
        if (Object.hasOwn(result, name)) {
          result[name] = ReviveValue(result[name], type.keys[name]);
        }
      }
      return result;
    }
    default:
      return value;
  }
}

/** A boolean arrives as the integer 1 or 0, as text where the server typed it a `BIGINT`. */
function BooleanOf(cell: string | number): boolean {
  return Number(cell) !== 0;
}

/**
 * Decodes one cell as the type the compiler gave it: a number from its text where the server
 * counted it, a boolean from its integer, an instant from its UTC text, JSON from its text.
 */
export function DecodeCell(cell: Cell, type: SqlType): RowValue {
  if (cell === null || cell === undefined) {
    return null;
  }
  if (Buffer.isBuffer(cell)) {
    return cell.toString("utf8");
  }
  switch (type.kind) {
    case "float":
      return Number(cell);
    case "bool":
      return BooleanOf(cell);
    case "timestamp":
      return IsString(cell) ? InstantOf(cell) : new Date(cell);
    case "text":
      return String(cell);
    case "json":
    case "array":
      return ReviveValue(ParseJson(String(cell)), type);
  }
}

/** The document a decoded overflow cell holds, empty where it holds none. */
function OverflowOf(cell: Cell): RowObject {
  if (cell === null || cell === undefined) {
    return {};
  }
  const parsed = ParseJson(String(cell));
  return IsDocument(parsed) ? parsed : {};
}

/**
 * The document a stored row holds: its key, its named instance, its declared fields, and the
 * overflow document's keys beside them. A key the overflow holds under a declared field's name or a
 * reserved name is the field's, as the document built in SQL reads it.
 */
export function DecodeRow(row: Row, table: TableModel): RowObject {
  const document: RowObject = {};
  const id = row.get(ID_COLUMN);
  const instance = row.get(INSTANCE_COLUMN);
  if (id !== null && id !== undefined) {
    document[ID_COLUMN] = String(id);
  }
  if (
    instance !== null &&
    instance !== undefined &&
    instance !== DEFAULT_INSTANCE_ID
  ) {
    document[INSTANCE_COLUMN] = String(instance);
  }
  for (const [name, spec] of Object.entries(table.fields)) {
    const value = DecodeCell(row.get(spec.column), spec.type);
    if (value !== null) {
      document[name] = value;
    }
  }
  const overflow = OverflowOf(row.get(EXTRA_COLUMN));
  const reserved = new Set([
    ID_COLUMN,
    INSTANCE_COLUMN,
    ...Object.keys(table.fields),
  ]);
  for (const [name, value] of Object.entries(overflow)) {
    if (!reserved.has(name)) {
      document[name] = value;
    }
  }
  return document;
}
