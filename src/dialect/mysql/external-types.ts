import type {
  CatalogColumn,
  ColumnReading,
  Conversion,
  ExternalTypeSyntax,
  NativeFamily,
} from "../external";
import { type Sql, int, join, lit, sql } from "../../statement";
import {
  BOOL,
  FLOAT,
  OPAQUE,
  type SqlType,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";
import { CheckFor } from "./external-checks";
import { json } from "./sql-json";

const FAMILY_BY_TYPE = new Map<string, NativeFamily>([
  ["char", "text"],
  ["varchar", "text"],
  ["tinytext", "text"],
  ["text", "text"],
  ["mediumtext", "text"],
  ["longtext", "text"],
  ["enum", "enum"],
  ["set", "set"],
  ["time", "rendered"],
  ["year", "rendered"],
  ["tinyint", "int"],
  ["smallint", "int"],
  ["mediumint", "int"],
  ["int", "int"],
  ["bigint", "bigint"],
  ["decimal", "decimal"],
  ["float", "float"],
  ["double", "double"],
  ["date", "date"],
  ["datetime", "datetime"],
  ["timestamp", "timestamp"],
  ["json", "json"],
]);

/** MySQL's spelling of a boolean: `BOOLEAN` is stored, and reported, as `tinyint(1)`. */
const BOOLEAN_TYPE = /^tinyint\(1\)/;

/** Fractional digits past which a read, at millisecond precision, loses something. */
const READ_FRACTION_DIGITS = 3;
const FRACTION_DIGITS = /\((\d+)\)/;

type Value = (column: Sql) => Sql;

const Bare: Value = (column) => column;
const AsText: Value = (column) => sql`CAST(${column} AS CHAR)`;
const AsDouble: Value = (column) => sql`CAST(${column} AS DOUBLE)`;
const AsBoolean: Value = (column) => sql`(${column} <> 0)`;
const DayAsInstant: Value = (column) => sql`CAST(${column} AS DATETIME(6))`;
const AsDay: Value = (value) => sql`CAST(${value} AS DATE)`;

const Unconverted: Conversion = (other) => other;

const INTEGER_PATTERN = sql`'^[[:space:]]*[+-]?[0-9]{1,64}[[:space:]]*$'`;
const DECIMAL_PATTERN = sql`'^[[:space:]]*[+-]?([0-9]{1,64}([.][0-9]{0,30})?|[.][0-9]{1,30})[[:space:]]*$'`;
const INSTANT_PATTERN = sql`'^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])( [0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?)?$'`;

/**
 * Text read as a number where it spells one, and NULL where it does not, so `_id` `42abc` matches
 * nothing instead of failing a statement that writes: strict mode turns a bad cast into an error
 * there. `DECIMAL(65,0)` holds every integer type exactly, unsigned `BIGINT` included.
 */
const IntegerText: Conversion = (other) =>
  sql`(CASE WHEN ${other} REGEXP ${INTEGER_PATTERN} THEN CAST(${other} AS DECIMAL(65,0)) END)`;

const DecimalText: Conversion = (other) =>
  sql`(CASE WHEN ${other} REGEXP ${DECIMAL_PATTERN} THEN CAST(${other} AS DECIMAL(65,30)) END)`;

/**
 * Text read as an instant where it spells a date, or a date and a time, that exists: the day is
 * checked against its month's last day inside nested `CASE`s, so February 30 is NULL rather than
 * an error, and the cast never sees a text the pattern refused.
 */
const InstantText: Conversion = (other) => {
  const day = sql`CAST(SUBSTRING(${other}, 9, 2) AS UNSIGNED)`;
  const lastDay = sql`DAYOFMONTH(LAST_DAY(CONCAT(SUBSTRING(${other}, 1, 8), '01')))`;
  const valid = sql`(CASE WHEN ${day} <= ${lastDay} THEN CAST(${other} AS DATETIME(6)) END)`;
  return sql`(CASE WHEN ${other} REGEXP ${INSTANT_PATTERN} THEN ${valid} END)`;
};

/** `FLOAT` equality: the number as the single-precision value the column stores, since 0.1 is not. */
const FloatConversion: Conversion = (other, operator) =>
  operator === "=" ? sql`CAST(${other} AS FLOAT)` : other;

const TEXT_CONVERSIONS: Partial<Record<NativeFamily, Conversion>> = {
  text: Unconverted,
  enum: Unconverted,
  int: IntegerText,
  bigint: IntegerText,
  decimal: DecimalText,
  date: InstantText,
  datetime: InstantText,
  timestamp: InstantText,
};

const NUMERIC_FAMILIES: readonly NativeFamily[] = ["int", "bigint", "decimal"];

/** How a column of one family is read as one declared kind, before the column's own facts. */
interface Reading {
  readonly value: Value;
  readonly lossy?: string;
  readonly conversion?: Conversion;
  readonly writing?: Value;
}

const LOSSY_BIGINT =
  "a BIGINT beyond 2^53 loses precision as a number; declare it string to read it exactly";
const LOSSY_DECIMAL =
  "a DECIMAL loses precision as a number; declare it string to read it exactly";
const LOSSY_FLOAT =
  "a FLOAT widened to a number is not the decimal it was written as";
const NAIVE = "a DATETIME holds no time zone and is read as UTC";
const MICROSECONDS = "microseconds are truncated to milliseconds";

const TEXT_READINGS: Partial<Record<NativeFamily, Reading>> = {
  text: { value: Bare, conversion: Unconverted, writing: Bare },
  enum: { value: Bare, conversion: Unconverted, writing: Bare },
  set: { value: Bare },
  rendered: { value: AsText, writing: Bare },
  int: { value: AsText, conversion: IntegerText, writing: Bare },
  bigint: { value: AsText, conversion: IntegerText, writing: Bare },
  decimal: { value: AsText, conversion: DecimalText, writing: Bare },
};

const FLOAT_READINGS: Partial<Record<NativeFamily, Reading>> = {
  bool: { value: AsDouble, conversion: Unconverted, writing: Bare },
  int: { value: AsDouble, conversion: Unconverted, writing: Bare },
  bigint: {
    value: AsDouble,
    lossy: LOSSY_BIGINT,
    conversion: Unconverted,
    writing: Bare,
  },
  decimal: {
    value: AsDouble,
    lossy: LOSSY_DECIMAL,
    conversion: Unconverted,
    writing: Bare,
  },
  float: {
    value: AsDouble,
    lossy: LOSSY_FLOAT,
    conversion: FloatConversion,
    writing: Bare,
  },
  double: { value: Bare, writing: Bare },
};

const TIMESTAMP_READINGS: Partial<Record<NativeFamily, Reading>> = {
  timestamp: { value: Bare, writing: Bare },
  datetime: { value: Bare, lossy: NAIVE, writing: Bare },
  date: { value: DayAsInstant, conversion: Unconverted, writing: AsDay },
};

/**
 * Every pairing of a declared kind with a native family that registration accepts.
 *
 * The one owner of the type policy: a pairing absent here is refused, a pairing with a `lossy`
 * reason is accepted with that reason as its warning, and `value` is how every read of the column
 * sees it. A list is a `JSON` column, read and written as JSON.
 */
const READINGS: Record<
  SqlType["kind"],
  Partial<Record<NativeFamily, Reading>>
> = {
  text: TEXT_READINGS,
  float: FLOAT_READINGS,
  bool: { bool: { value: AsBoolean, writing: Bare } },
  timestamp: TIMESTAMP_READINGS,
  json: { json: { value: Bare, writing: Bare } },
  array: { json: { value: Bare, writing: Bare } },
};

/**
 * The families a key column may have, each read as the text `_id` is built from: a date or an
 * instant as the server spells it under the session's UTC zone, so its `_id` is stable. A float, a
 * set or a JSON column is no identity and is not offered.
 */
const KEY_FAMILIES: readonly NativeFamily[] = [
  "text",
  "enum",
  "rendered",
  "bool",
  "int",
  "bigint",
  "decimal",
  "date",
  "datetime",
  "timestamp",
];

const PROPOSED: Record<NativeFamily, SqlType> = {
  text: TEXT,
  enum: TEXT,
  set: TEXT,
  rendered: TEXT,
  bool: BOOL,
  int: FLOAT,
  bigint: FLOAT,
  decimal: FLOAT,
  float: FLOAT,
  double: FLOAT,
  date: TIMESTAMP,
  datetime: TIMESTAMP,
  timestamp: TIMESTAMP,
  json: OPAQUE,
};

function Family(column: CatalogColumn): NativeFamily | undefined {
  if (column.dataType === "tinyint" && BOOLEAN_TYPE.test(column.native)) {
    return "bool";
  }
  return FAMILY_BY_TYPE.get(column.dataType);
}

/** What reading an instant column at millisecond precision loses, beside what its family loses. */
function InstantLoss(
  kind: SqlType,
  family: NativeFamily,
  column: CatalogColumn,
  lossy: string | undefined,
): string | undefined {
  const fraction = FRACTION_DIGITS.exec(column.native);
  const truncated =
    kind.kind === "timestamp" &&
    family !== "date" &&
    Number(fraction?.[1] ?? 0) > READ_FRACTION_DIGITS;
  if (!truncated) {
    return lossy;
  }
  return lossy ? `${lossy}; ${MICROSECONDS}` : MICROSECONDS;
}

function ReadOnlyReason(
  column: CatalogColumn,
  reading: Reading,
): string | undefined {
  if (column.generated) {
    return "a generated column";
  }
  return reading.writing
    ? undefined
    : `a ${column.native} column, read-only in this version`;
}

function ReadingOf(kind: SqlType, column: CatalogColumn) {
  const family = Family(column);
  const reading = family ? READINGS[kind.kind][family] : undefined;
  if (!family || !reading) {
    return undefined;
  }
  const readOnly = ReadOnlyReason(column, reading);
  return {
    family,
    value: reading.value,
    lossy: InstantLoss(kind, family, column, reading.lossy),
    conversion: reading.conversion,
    numeric: kind.kind === "float" && NUMERIC_FAMILIES.includes(family),
    writing: readOnly ? undefined : reading.writing,
    readOnly,
    check: CheckFor(kind, family, column),
  } satisfies ColumnReading;
}

function KeyReading(column: CatalogColumn): ColumnReading | undefined {
  const family = Family(column);
  if (!family || !KEY_FAMILIES.includes(family)) {
    return undefined;
  }
  const text = TEXT_READINGS[family];
  const readOnly = column.generated ? "a generated column" : undefined;
  return {
    family,
    value: text?.value ?? AsText,
    conversion: TEXT_CONVERSIONS[family],
    numeric: false,
    writing: readOnly ? undefined : Bare,
    readOnly,
    check: CheckFor(TEXT, family, column),
  };
}

/** A value truncated to the milliseconds a read answers, where `CAST(... AS DATETIME(3))` would round. */
function AsRead(kind: SqlType, value: Sql): Sql {
  return kind.kind === "timestamp"
    ? sql`TIMESTAMPADD(MICROSECOND, -(MICROSECOND(${value}) % 1000), ${value})`
    : value;
}

/** The array an `_id` spells, where it is valid JSON; the cast never sees text that is not. */
function IdDocument(id: Sql): Sql {
  return sql`(CASE WHEN JSON_VALID(${id}) THEN CAST(${id} AS JSON) END)`;
}

/**
 * Each part of a composite `_id` as text, from an array of exactly the key's width. The `CASE`s
 * are nested rather than joined by `AND`, whose operands the server may evaluate in any order.
 */
function IdParts(id: Sql, width: number): Sql[] {
  const document = IdDocument(id);
  const sized = sql`(${json.is(document, ["array"])} AND JSON_LENGTH(${document}) = ${int(width)})`;
  return Array.from({ length: width }, (_, position) => {
    const element = sql`JSON_EXTRACT(${document}, ${lit(`$[${position}]`)})`;
    return sql`(CASE WHEN ${sized} THEN ${json.as(element, "text")} END)`;
  });
}

export const types: ExternalTypeSyntax = {
  family: Family,
  reading: ReadingOf,
  keyReading: KeyReading,
  proposed: (family) => PROPOSED[family],
  asRead: AsRead,
  compositeId: (parts) =>
    sql`CAST(JSON_ARRAY(${join(parts, sql`, `)}) AS CHAR)`,
  idParts: IdParts,
};
