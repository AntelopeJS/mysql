import type {
  CatalogColumn,
  CheckedValue,
  NativeFamily,
  ValueCheck,
} from "../external";
import type { SqlType } from "../../implementations/database/types";

/** The bits of each integer type, which with its sign give the range a written value must fit. */
const INTEGER_BITS = new Map([
  ["tinyint", 8n],
  ["smallint", 16n],
  ["mediumint", 24n],
  ["int", 32n],
  ["bigint", 64n],
]);

/** The bytes each unsized text type holds; `longtext` holds more than any payload carries. */
const TEXT_BYTES = new Map([
  ["tinytext", 255],
  ["text", 65_535],
  ["mediumtext", 16_777_215],
]);

const SIZED_TEXT = /^(?:var)?char\((\d+)\)/;
const DECIMAL_SIZE = /^decimal\((\d+),(\d+)\)/;
const INTEGER_TEXT = /^\s*[+-]?\d+\s*$/;
const DECIMAL_TEXT = /^\s*[+-]?(\d+)(?:\.\d*)?\s*$|^\s*[+-]?\.\d+\s*$/;
const UNSIGNED = /\bunsigned\b/;

/** `TIMESTAMP`'s range: one second after the epoch to the last second of 2038-01-19, UTC. */
const TIMESTAMP_RANGE = [
  Date.UTC(1970, 0, 1, 0, 0, 1),
  Date.UTC(2038, 0, 19, 3, 14, 7, 999),
] as const;

/** `DATE`'s and `DATETIME`'s range: the years 1000 to 9999. */
const CALENDAR_RANGE = [
  Date.UTC(1000, 0, 1),
  Date.UTC(9999, 11, 31, 23, 59, 59, 999),
] as const;

const DEFAULT_DECIMAL = { precision: 10, scale: 0 };

interface IntegerRange {
  readonly min: bigint;
  readonly max: bigint;
}

function IntegerRangeOf(column: CatalogColumn): IntegerRange {
  const bits = INTEGER_BITS.get(column.dataType) ?? 64n;
  if (UNSIGNED.test(column.native)) {
    return { min: 0n, max: 2n ** bits - 1n };
  }
  return { min: -(2n ** (bits - 1n)), max: 2n ** (bits - 1n) - 1n };
}

function DecimalSizeOf(column: CatalogColumn) {
  const match = DECIMAL_SIZE.exec(column.native);
  if (!match) {
    return DEFAULT_DECIMAL;
  }
  return { precision: Number(match[1]), scale: Number(match[2]) };
}

function InRange(value: bigint, range: IntegerRange): boolean {
  return value >= range.min && value <= range.max;
}

/** Digits a decimal holds before its point, which is all a written value can overflow by. */
function IntegerDigits(column: CatalogColumn): number {
  const size = DecimalSizeOf(column);
  return size.precision - size.scale;
}

function WholeDigits(text: string): number {
  return text.replace(/^0+/, "").length;
}

const NOT_A_FIT = (column: CatalogColumn) => `the column is ${column.native}`;

function TextLength(column: CatalogColumn): ValueCheck | undefined {
  const sized = SIZED_TEXT.exec(column.native);
  if (sized) {
    const limit = Number(sized[1]);
    return (value) =>
      value.kind === "text" && Array.from(value.value).length > limit
        ? NOT_A_FIT(column)
        : undefined;
  }
  const bytes = TEXT_BYTES.get(column.dataType);
  if (bytes === undefined) {
    return undefined;
  }
  return (value) =>
    value.kind === "text" && Buffer.byteLength(value.value, "utf8") > bytes
      ? NOT_A_FIT(column)
      : undefined;
}

/**
 * MySQL's `latin1`, which is Windows cp1252 with its five unassigned bytes read as the C1 controls
 * of the same number, exactly as the WHATWG decoder of `windows-1252` reads them.
 */
const LATIN1 = new Set(
  Array.from(
    new TextDecoder("windows-1252").decode(
      Uint8Array.from({ length: 256 }, (_, byte) => byte),
    ),
    (char) => char.codePointAt(0),
  ),
);

const LAST_BMP = 0xffff;
const LAST_ASCII = 0x7f;

/** Whether each character set the module knows the repertoire of holds a code point. */
const REPERTOIRES = new Map<string, (codePoint: number) => boolean>([
  ["utf8mb3", (codePoint) => codePoint <= LAST_BMP],
  ["utf8", (codePoint) => codePoint <= LAST_BMP],
  ["ucs2", (codePoint) => codePoint <= LAST_BMP],
  ["ascii", (codePoint) => codePoint <= LAST_ASCII],
  ["latin1", (codePoint) => LATIN1.has(codePoint)],
]);

/**
 * Text the column's character set cannot hold, refused before the write: the server refuses it
 * too, but MySQL 9.7 does so without naming the column when the value is assigned conditionally.
 */
function TextRepertoire(column: CatalogColumn): ValueCheck | undefined {
  const holds =
    column.charset === null ? undefined : REPERTOIRES.get(column.charset);
  if (!holds) {
    return undefined;
  }
  return (value) => {
    if (value.kind !== "text") {
      return undefined;
    }
    const outside = Array.from(value.value).find(
      (char) => !holds(char.codePointAt(0) ?? 0),
    );
    return outside === undefined
      ? undefined
      : `the column is ${column.native} in ${column.charset}, which cannot hold ${JSON.stringify(outside)}`;
  };
}

/** A text column's checks: its length, then its character set. */
function TextFits(column: CatalogColumn): ValueCheck | undefined {
  const checks = [TextLength(column), TextRepertoire(column)].filter(
    (check) => check !== undefined,
  );
  if (checks.length === 0) {
    return undefined;
  }
  return (value) =>
    checks.map((check) => check(value)).find((reason) => reason !== undefined);
}

/** A collation that compares without case, which every `_ci` collation does. */
const CASE_INSENSITIVE = /_ci$/;

/**
 * A value that names one of the labels: the label itself, or under a collation without case the
 * label in another case, which MySQL stores as the label. Any other value is refused, a label's
 * position included, which MySQL would store as that label without a word.
 */
function EnumLabel(column: CatalogColumn): ValueCheck {
  const labels = column.enumLabels ?? [];
  const isCaseInsensitive = CASE_INSENSITIVE.test(column.collation ?? "");
  const names = (text: string) =>
    labels.some(
      (label) =>
        label === text ||
        (isCaseInsensitive &&
          label.localeCompare(text, undefined, { sensitivity: "accent" }) ===
            0),
    );
  return (value) =>
    value.kind === "text" && !names(value.value)
      ? `it is not one of the labels of ${column.native}`
      : undefined;
}

function IntegerText(column: CatalogColumn): ValueCheck {
  const range = IntegerRangeOf(column);
  return (value) => {
    if (value.kind !== "text") {
      return undefined;
    }
    const text = value.value;
    return INTEGER_TEXT.test(text) && InRange(BigInt(text.trim()), range)
      ? undefined
      : NOT_A_FIT(column);
  };
}

function DecimalText(column: CatalogColumn): ValueCheck {
  const digits = IntegerDigits(column);
  return (value) => {
    if (value.kind !== "text") {
      return undefined;
    }
    const match = DECIMAL_TEXT.exec(value.value);
    if (!match) {
      return NOT_A_FIT(column);
    }
    return WholeDigits(match[1] ?? "") > digits ? NOT_A_FIT(column) : undefined;
  };
}

function WholeNumber(column: CatalogColumn): ValueCheck {
  const range = IntegerRangeOf(column);
  return (value) => {
    if (value.kind !== "number") {
      return undefined;
    }
    const number = value.value;
    return Number.isInteger(number) && InRange(BigInt(number), range)
      ? undefined
      : `${NOT_A_FIT(column)}, which holds whole numbers from ${range.min} to ${range.max}`;
  };
}

function DecimalNumber(column: CatalogColumn): ValueCheck {
  const digits = IntegerDigits(column);
  return (value) =>
    value.kind === "number" &&
    (!Number.isFinite(value.value) || Math.abs(value.value) >= 10 ** digits)
      ? NOT_A_FIT(column)
      : undefined;
}

function FiniteNumber(column: CatalogColumn): ValueCheck {
  return (value) =>
    value.kind === "number" && !Number.isFinite(value.value)
      ? NOT_A_FIT(column)
      : undefined;
}

function InstantWithin(
  column: CatalogColumn,
  range: readonly [number, number],
): ValueCheck {
  return (value: CheckedValue) => {
    if (value.kind !== "date") {
      return undefined;
    }
    const time = value.value.getTime();
    return Number.isNaN(time) || time < range[0] || time > range[1]
      ? `${NOT_A_FIT(column)}, which holds ${new Date(range[0]).toISOString()} to ${new Date(range[1]).toISOString()}`
      : undefined;
  };
}

type CheckOf = (column: CatalogColumn) => ValueCheck | undefined;

/**
 * What a written constant is checked against before the statement runs, per declared kind and
 * family. Strict mode refuses most of these values itself, but not all: a fraction written into an
 * integer column is rounded, a decimal written past its scale is rounded, and a number written past
 * an integer's range in a text field is refused without the field's name.
 */
const CHECKS: Partial<
  Record<SqlType["kind"], Partial<Record<NativeFamily, CheckOf>>>
> = {
  text: {
    text: TextFits,
    enum: EnumLabel,
    int: IntegerText,
    bigint: IntegerText,
    decimal: DecimalText,
  },
  float: {
    bool: WholeNumber,
    int: WholeNumber,
    bigint: WholeNumber,
    decimal: DecimalNumber,
    float: FiniteNumber,
    double: FiniteNumber,
  },
  timestamp: {
    timestamp: (column) => InstantWithin(column, TIMESTAMP_RANGE),
    datetime: (column) => InstantWithin(column, CALENDAR_RANGE),
    date: (column) => InstantWithin(column, CALENDAR_RANGE),
  },
};

/** The check a written value of `kind` must pass for a column of `family`, if any. */
export function CheckFor(
  kind: SqlType,
  family: NativeFamily,
  column: CatalogColumn,
): ValueCheck | undefined {
  return CHECKS[kind.kind]?.[family]?.(column);
}
