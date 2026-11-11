import type { Dialect } from "../../dialect";
import type {
  CatalogColumn,
  ColumnReading,
  NativeFamily,
} from "../../dialect/external";
import { BOOL, FLOAT, OPAQUE, type SqlType, TEXT, TIMESTAMP } from "./types";

/**
 * One declared field over the column it reads, with everything every later stage needs: how the
 * column is read, compared, aggregated and written, and the facts a write needs. Built once at
 * registration, from the catalog.
 */
export interface ColumnDescriptor extends ColumnReading {
  readonly field: string;
  readonly column: string;
  readonly kind: SqlType;
  readonly native: string;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
  readonly defaultExpression: string | null;
  readonly autoIncrement: boolean;
}

const DECLARED_NAMES: Record<SqlType["kind"], string> = {
  text: "string",
  float: "number",
  bool: "boolean",
  timestamp: "date",
  json: "object",
  array: "an array",
};

/** The scalar kinds a column can be declared as, in the order a refusal lists them. */
export const SCALAR_KINDS: readonly SqlType[] = [
  TEXT,
  FLOAT,
  BOOL,
  TIMESTAMP,
  OPAQUE,
];

/** The declared kinds a column can be read as, for the message that refuses one it cannot. */
function AcceptedNames(dialect: Dialect, column: CatalogColumn): string {
  const names = SCALAR_KINDS.filter(
    (kind) => dialect.external.types.reading(kind, column) !== undefined,
  ).map((kind) => DECLARED_NAMES[kind.kind]);
  return names.length > 0
    ? `declare it as ${names.join(" or ")}`
    : "no field type reads it";
}

function Descriptor(
  field: string,
  kind: SqlType,
  column: CatalogColumn,
  reading: ColumnReading,
): ColumnDescriptor {
  return {
    ...reading,
    field,
    column: column.name,
    kind,
    native: column.native,
    notNull: column.notNull,
    hasDefault: column.hasDefault,
    defaultExpression: column.defaultExpression,
    autoIncrement: column.autoIncrement,
  };
}

/**
 * Describes a declared field over the catalog column it reads, or refuses a pairing the dialect's
 * type policy does not accept, naming the field, the column, its type and the declarations that
 * would read it.
 */
export function Describe(
  dialect: Dialect,
  field: string,
  kind: SqlType,
  column: CatalogColumn,
  path: string,
): ColumnDescriptor {
  const reading = dialect.external.types.reading(kind, column);
  if (!reading) {
    throw new Error(
      `Field '${path}' is declared ${DECLARED_NAMES[kind.kind]}, but column \`${column.name}\` is ${column.native}: ${AcceptedNames(dialect, column)}`,
    );
  }
  return Descriptor(field, kind, column, reading);
}

/** A key column read as text for `_id`, or nothing when its type cannot serve as an identity. */
export function DescribeKey(
  dialect: Dialect,
  column: CatalogColumn,
): ColumnDescriptor | undefined {
  const reading = dialect.external.types.keyReading(column);
  return reading && Descriptor(column.name, TEXT, column, reading);
}

/**
 * The key's columns described for `_id`, or nothing when there is no key or any of its columns
 * cannot serve as one.
 */
export function DescribeKeyColumns(
  dialect: Dialect,
  key: readonly string[] | undefined,
  columns: ReadonlyMap<string, CatalogColumn>,
): ColumnDescriptor[] | undefined {
  const described = (key ?? []).map((name) => {
    const column = columns.get(name);
    return column ? DescribeKey(dialect, column) : undefined;
  });
  const parts = described.filter((part) => part !== undefined);
  if (described.length === 0 || parts.length !== described.length) {
    return undefined;
  }
  return parts;
}

/** A column only the database writes: generated, or of a type no write assigns in this version. */
export function IsReadOnly(descriptor: ColumnDescriptor): boolean {
  return descriptor.writing === undefined;
}

/** Why a column is read-only, for the message that refuses a value for it. */
export function ReadOnlyReason(descriptor: ColumnDescriptor): string {
  return (
    descriptor.readOnly ?? `a ${descriptor.native} column no write assigns`
  );
}

/** The families whose values are text a person wrote, which a profile measures by length only. */
export const TEXT_FAMILIES: readonly NativeFamily[] = ["text"];
