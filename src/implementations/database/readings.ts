import type { Dialect } from "../../dialect";
import { type Sql, sql } from "../../statement";
import type { Compiled } from "./sql";
import { Cast, WithDefault } from "./coerce";
import {
  type ArrayType,
  BOOL,
  FLOAT,
  IsJsonBacked,
  type JsonType,
  OPAQUE,
  type SqlType,
  TEXT,
  TIMESTAMP,
} from "./types";

/** The epoch milliseconds an instant reads as are a thousand to the second. */
export const MILLISECONDS_PER_SECOND = sql`1000`;

/** Reads a fragment as a double, which every numeric result owes the driver. */
export function AsFloat(dialect: Dialect, value: Sql): Compiled {
  return { sql: dialect.sql.scalar.cast(value, "float"), type: FLOAT };
}

type Rendering = (dialect: Dialect, value: Sql) => Sql;

const RENDERING: Partial<Record<SqlType["kind"], Rendering>> = {
  timestamp: (dialect, value) => dialect.sql.time.isoText(value),
  bool: (_dialect, value) =>
    sql`(CASE WHEN ${value} THEN 'true' WHEN NOT ${value} THEN 'false' END)`,
};

/**
 * Reads a value as text, using JavaScript's own spelling for every scalar kind: an instant as
 * `toISOString` spells it in UTC and a boolean as `true` or `false`. A number agrees over the
 * magnitudes a caller renders in practice; the engine reaches for exponent notation at different
 * magnitudes than `Number.prototype.toString` does.
 */
export function Text(dialect: Dialect, value: Compiled): Compiled {
  const rendering = RENDERING[value.type.kind];
  if (!rendering) {
    return Cast(dialect, value, TEXT);
  }
  return { sql: rendering(dialect, value.sql), type: TEXT };
}

/**
 * The kinds the engine orders, each mapped to the type an ordering of it answers with. A boolean
 * or a JSON operand has no ordering, so every comparison the compiler emits either reads one of
 * these directly or falls back to {@link Numeric}. The array reducers share the table rather than
 * each carrying one, so `min` over a stream and over an array cannot answer the same data apart.
 */
export const ORDERED_KINDS: Partial<Record<SqlType["kind"], SqlType>> = {
  text: TEXT,
  float: FLOAT,
  timestamp: TIMESTAMP,
};

const NUMERATION: Partial<Record<SqlType["kind"], Rendering>> = {
  bool: (dialect, value) => dialect.sql.scalar.cast(value, "float"),
  timestamp: (dialect, value) => dialect.sql.time.toEpochMs(value),
  text: (dialect, value) => dialect.sql.scalar.parseNumber(value),
};

/**
 * Reads a value as a number, following JavaScript's `Number(x)` where the two systems agree.
 *
 * A boolean is 1 or 0 and an instant its epoch milliseconds. Text is read only where it spells a
 * decimal literal, so `""` is NULL where `Number("")` is `0` and `"0x10"` is NULL where JavaScript
 * reads 16. A JSON operand keeps the guarded projection, NULL for anything but a JSON number.
 */
export function Numeric(dialect: Dialect, value: Compiled): Compiled {
  const numeration = NUMERATION[value.type.kind];
  if (!numeration) {
    return Cast(dialect, value, FLOAT);
  }
  return { sql: numeration(dialect, value.sql), type: FLOAT };
}

type Instant = (dialect: Dialect, value: Compiled) => Sql;

const FromEpoch: Instant = (dialect, value) =>
  dialect.sql.time.fromEpochMs(Numeric(dialect, value).sql);

const INSTANT: Partial<Record<SqlType["kind"], Instant>> = {
  float: FromEpoch,
  bool: FromEpoch,
  text: (dialect, value) => dialect.sql.time.parseText(value.sql),
};

/**
 * Reads a value as an instant, using JavaScript's `new Date(x)` for every scalar kind: a number as
 * epoch milliseconds, a boolean through its numeric reading, and text where it spells an ISO 8601
 * date or date-time. Anything outside the range an instant column holds is NULL.
 */
export function Moment(dialect: Dialect, value: Compiled): Compiled {
  const instant = INSTANT[value.type.kind];
  if (!instant) {
    return Cast(dialect, value, TIMESTAMP);
  }
  return { sql: instant(dialect, value), type: TIMESTAMP };
}

const TRUTHINESS: Record<SqlType["kind"], Rendering> = {
  bool: (_dialect, value) => value,
  float: (_dialect, value) => sql`(${value} <> 0)`,
  text: (_dialect, value) => sql`(${value} <> '')`,
  timestamp: (_dialect, value) => sql`(${value} IS NOT NULL)`,
  json: (dialect, value) => dialect.sql.json.truthy(value),
  array: (dialect, value) => dialect.sql.json.truthy(value),
};

/**
 * Reads a value as a condition, using JavaScript's truthiness for every kind.
 *
 * The table is total, so a JSON operand is read for every value it can hold rather than as a JSON
 * boolean only: a stored `["a"]` is true and `0` is false, in `filter(k)` and `filter(k.not())`
 * alike. SQL NULL stays NULL, which is what makes the three-valued logic agree with JavaScript's
 * `undefined`.
 */
export function Predicate(dialect: Dialect, value: Compiled): Compiled {
  return { sql: TRUTHINESS[value.type.kind](dialect, value.sql), type: BOOL };
}

type Reading = (dialect: Dialect, value: Compiled) => Compiled;

type ScalarType = Exclude<SqlType, ArrayType | JsonType>;

const STORED_READINGS: Record<ScalarType["kind"], Reading> = {
  float: Numeric,
  text: Text,
  bool: Predicate,
  timestamp: Moment,
};

/**
 * Reads a value as the type of the column it is compared against.
 *
 * Over a scalar key the readings are exactly the ones the expression compiler applies, so a key
 * that addressed a row on the way in addresses it on the way back. Either side being JSON takes
 * {@link Cast} instead, where it is total.
 */
export function StoredAs(
  dialect: Dialect,
  value: Compiled,
  target: SqlType,
): Compiled {
  if (IsJsonBacked(target) || IsJsonBacked(value.type)) {
    return Cast(dialect, value, target);
  }
  return STORED_READINGS[target.kind](dialect, value);
}

type Written = (dialect: Dialect, value: Compiled, subject: string) => Compiled;

/**
 * Reads a caller-supplied value against a boolean column, which only a boolean is: truthiness is
 * total and so would store `"false"` as true without a word.
 */
const StoredBoolean: Written = (dialect, value, subject) => {
  if (value.type.kind === "bool") {
    return value;
  }
  if (IsJsonBacked(value.type)) {
    return Cast(dialect, value, BOOL);
  }
  throw new Error(
    `${subject} takes a boolean or a JSON boolean for a boolean column, received ${value.type.kind}`,
  );
};

const WRITTEN_READINGS: Partial<Record<SqlType["kind"], Written>> = {
  bool: StoredBoolean,
};

/**
 * Reads a value being written into a column as that column's type: {@link StoredAs} with the one
 * narrower reading {@link StoredBoolean} states. A payload member and a `key(name, def)` default are
 * the same question, so both read through here.
 */
export function WrittenAs(
  dialect: Dialect,
  value: Compiled,
  target: SqlType,
  subject: string,
): Compiled {
  const narrowed = WRITTEN_READINGS[target.kind];
  if (!narrowed) {
    return StoredAs(dialect, value, target);
  }
  return narrowed(dialect, value, subject);
}

/**
 * A field's default, read as the type of the column it stands in for, so a default never changes
 * how the column itself is read. The `default` stage does not come through here: its default is an
 * alternative value, which unifies with the value instead.
 */
export function Defaulted(
  dialect: Dialect,
  value: Compiled,
  def: Compiled | undefined,
  subject: string,
): Compiled {
  if (!def) {
    return value;
  }
  return WithDefault(
    dialect,
    value,
    WrittenAs(dialect, def, value.type, subject),
  );
}

/** Reads a value as JSON, which is the operand every container stage works from. */
export function AsJson(dialect: Dialect, value: Compiled): Compiled {
  return Cast(dialect, value, OPAQUE);
}
