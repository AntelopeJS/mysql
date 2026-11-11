import type {
  Categories,
  CategoryCount,
  ColumnProfile,
  ColumnTrait,
  LengthStats,
  Measure,
  MonthCount,
  ValueRange,
} from "@antelopejs/interface-database-catalog";

import { GetDialect, type Row } from "../../connection";
import type { CatalogColumn, NativeFamily } from "../../dialect/external";
import { type Sql, int, sql } from "../../statement";
import {
  FirstRow,
  Mapped,
  type MeasureSession,
  NumberOf,
  ValueOf,
} from "./external-measures";
import { type Source, SOURCE_ALIAS } from "./external-sample";
import { AcceptedDeclarations } from "./external-declarations";
import { DecodeCell } from "./result";
import { QualifiedColumn } from "./sql";
import { TEXT_FAMILIES } from "./external-types";
import { TIMESTAMP, type SqlType } from "./types";

/** A column with more distinct values than this has no categories. */
const CATEGORY_LIMIT = 25;
/** A value counted fewer times than this is a record, not a category, and is never named. */
const CATEGORY_MIN_ROWS = 5;
const ENUM_LIKE_MIN_ROWS = 100;
const MONTH_LIMIT = 36;
const LABEL_DISTINCT_SHARE = 0.9;
const LABEL_MAX_LENGTH = 80;
const TIME_AXIS_FILLED_SHARE = 0.9;
const TIME_AXIS_MIN_MONTHS = 3;
const MONTHS_PER_YEAR = 12;

const CATEGORY_FAMILIES: readonly NativeFamily[] = [
  ...TEXT_FAMILIES,
  "enum",
  "int",
  "bigint",
  "bool",
];
const DISTINCT_KINDS: readonly SqlType["kind"][] = [
  "text",
  "float",
  "bool",
  "timestamp",
];

/** A column on its way to a profile: its family, its proposed kind, and how it is read. */
export interface ProfiledColumn {
  name: string;
  family: NativeFamily;
  kind: SqlType;
  quoted: Sql;
}

export function Profiled(column: CatalogColumn): ProfiledColumn | undefined {
  const dialect = GetDialect();
  const family = dialect.external.types.family(column);
  const [proposed] = AcceptedDeclarations(dialect, column);
  if (!family || !proposed) {
    return undefined;
  }
  return {
    name: column.name,
    family,
    kind: proposed.kind,
    quoted: QualifiedColumn(SOURCE_ALIAS, column.name),
  };
}

/** An instant as registration reads the column: a `DATE` at midnight, the others as they are. */
function InstantExpression(column: ProfiledColumn): Sql {
  return column.family === "date"
    ? GetDialect().sql.scalar.cast(column.quoted, "timestamp")
    : column.quoted;
}

/** A date read as the instant registration reads it, an enum by its label, a number as one. */
function RangeExpression(column: ProfiledColumn): Sql | undefined {
  if (column.family === "enum") {
    return column.quoted;
  }
  if (column.kind.kind === "timestamp") {
    return InstantExpression(column);
  }
  return column.kind.kind === "float"
    ? GetDialect().sql.scalar.cast(column.quoted, "float")
    : undefined;
}

function IsText(column: ProfiledColumn): boolean {
  return TEXT_FAMILIES.includes(column.family);
}

function BaseSql(column: ProfiledColumn, source: Source): Sql {
  const range = RangeExpression(column);
  const length = GetDialect().external.measures.length(column.quoted);
  const extreme = (name: Sql) => (range ? sql`${name}(${range})` : sql`NULL`);
  const sized = (name: Sql) =>
    IsText(column) ? sql`${name}(${length})` : sql`NULL`;
  return sql`SELECT COUNT(*) - COUNT(${column.quoted}) AS nulls,
    ${extreme(sql`MIN`)} AS min_value, ${extreme(sql`MAX`)} AS max_value,
    ${sized(sql`MIN`)} AS min_length, ${sized(sql`AVG`)} AS avg_length, ${sized(sql`MAX`)} AS max_length
    FROM ${source.from}`;
}

/** One end of a range: an instant as ISO text, an enum label as itself, a number as one. */
function RangeEnd(column: ProfiledColumn, row: Row, name: string) {
  const cell = row.get(name);
  if (cell === null || cell === undefined) {
    return undefined;
  }
  if (column.kind.kind === "timestamp") {
    const instant = DecodeCell(cell, TIMESTAMP);
    return instant instanceof Date ? instant.toISOString() : undefined;
  }
  return column.family === "enum" ? String(cell) : Number(cell);
}

function RangeValue(column: ProfiledColumn, row: Row): ValueRange | undefined {
  const min = RangeEnd(column, row, "min_value");
  const max = RangeEnd(column, row, "max_value");
  return min === undefined || max === undefined ? undefined : { min, max };
}

function LengthValue(row: Row): LengthStats | undefined {
  const min = NumberOf(row, "min_length");
  const avg = NumberOf(row, "avg_length");
  const max = NumberOf(row, "max_length");
  return min === null || avg === null || max === null
    ? undefined
    : { min, avg, max };
}

interface BaseMeasures {
  nulls: Measure<number>;
  range?: Measure<ValueRange>;
  length?: Measure<LengthStats>;
}

function Present<T>(value: T | undefined): Measure<T> {
  return value === undefined
    ? { status: "error", code: "empty" }
    : { status: "ok", value };
}

async function MeasureBase(
  session: MeasureSession,
  column: ProfiledColumn,
  source: Source,
): Promise<BaseMeasures> {
  const measured = await session.measure(BaseSql(column, source));
  const base: BaseMeasures = {
    nulls: FirstRow(measured, (row) => NumberOf(row, "nulls") ?? 0),
  };
  const row = ValueOf(measured)?.[0];
  if (RangeExpression(column)) {
    base.range =
      measured.status === "ok"
        ? Present(row && RangeValue(column, row))
        : measured;
  }
  if (IsText(column)) {
    base.length =
      measured.status === "ok" ? Present(row && LengthValue(row)) : measured;
  }
  return base;
}

async function MeasureDistinct(
  session: MeasureSession,
  column: ProfiledColumn,
  source: Source,
): Promise<Measure<number> | undefined> {
  if (!DISTINCT_KINDS.includes(column.kind.kind)) {
    return undefined;
  }
  const measured = await session.measure(
    sql`SELECT COUNT(DISTINCT ${column.quoted}) AS distinct_values FROM ${source.from}`,
  );
  return FirstRow(measured, (row) => NumberOf(row, "distinct_values") ?? 0);
}

/** How a category is named: a number as one, a boolean as one, anything else as its text. */
function CategoryValue(column: ProfiledColumn): Sql {
  const scalar = GetDialect().sql.scalar;
  switch (column.family) {
    case "int":
    case "bigint":
      return scalar.cast(column.quoted, "float");
    case "bool":
      return scalar.cast(column.quoted, "bool");
    default:
      return scalar.cast(column.quoted, "text");
  }
}

function CategoryOf(column: ProfiledColumn, row: Row): CategoryCount {
  const cell = row.get("category") ?? null;
  const rows = NumberOf(row, "category_rows") ?? 0;
  if (column.family === "bool") {
    return { value: Number(cell) !== 0, rows };
  }
  if (column.family === "int" || column.family === "bigint") {
    return { value: Number(cell), rows };
  }
  return { value: String(cell), rows };
}

/** Values counted often enough to be categories; every rarer value only adds to `other`. */
function AsCategories(counts: CategoryCount[]): Categories {
  return {
    values: counts.filter((count) => count.rows >= CATEGORY_MIN_ROWS),
    other: counts
      .filter((count) => count.rows < CATEGORY_MIN_ROWS)
      .reduce((total, count) => total + count.rows, 0),
  };
}

async function MeasureCategories(
  session: MeasureSession,
  column: ProfiledColumn,
  source: Source,
  distinct: number | undefined,
): Promise<Measure<Categories> | undefined> {
  const isCategorical =
    column.family === "enum" || (distinct ?? Infinity) <= CATEGORY_LIMIT;
  if (!CATEGORY_FAMILIES.includes(column.family) || !isCategorical) {
    return undefined;
  }
  const measured = await session.measure(
    sql`SELECT ${CategoryValue(column)} AS category, COUNT(*) AS category_rows FROM ${source.from}
      WHERE ${column.quoted} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${int(CATEGORY_LIMIT + 1)}`,
  );
  return Mapped(measured, (rows) =>
    AsCategories(rows.map((row) => CategoryOf(column, row))),
  );
}

async function MeasureMonths(
  session: MeasureSession,
  column: ProfiledColumn,
  source: Source,
): Promise<Measure<MonthCount[]> | undefined> {
  if (column.kind.kind !== "timestamp") {
    return undefined;
  }
  const month = GetDialect().external.measures.month(InstantExpression(column));
  const measured = await session.measure(
    sql`SELECT ${month} AS month, COUNT(*) AS month_rows FROM ${source.from}
      WHERE ${column.quoted} IS NOT NULL GROUP BY 1 ORDER BY 1 DESC LIMIT ${int(MONTH_LIMIT)}`,
  );
  return Mapped(measured, (rows) =>
    rows
      .map((row) => ({
        month: String(row.get("month")),
        rows: NumberOf(row, "month_rows") ?? 0,
      }))
      .reverse(),
  );
}

/** Calendar months a range spans, both ends counted. */
function MonthsSpanned(range: ValueRange): number {
  const start = new Date(String(range.min));
  const end = new Date(String(range.max));
  return (
    (end.getUTCFullYear() - start.getUTCFullYear()) * MONTHS_PER_YEAR +
    end.getUTCMonth() -
    start.getUTCMonth() +
    1
  );
}

/** What the relation's keys and references say about a column, for its traits. */
export interface ColumnRoles {
  keys: Set<string>;
  references: Set<string>;
}

interface TraitFacts {
  column: ProfiledColumn;
  profile: ColumnProfile;
  rows: number | undefined;
  roles: ColumnRoles;
}

type TraitRule = (facts: TraitFacts) => boolean;

function Filled(facts: TraitFacts): number | undefined {
  const nulls = ValueOf(facts.profile.nulls);
  return facts.rows === undefined || nulls === undefined
    ? undefined
    : facts.rows - nulls;
}

const TRAIT_RULES: Record<ColumnTrait, TraitRule> = {
  "enum-like": (facts) =>
    facts.column.family === "enum" ||
    (CATEGORY_FAMILIES.includes(facts.column.family) &&
      (ValueOf(facts.profile.distinct) ?? Infinity) <= CATEGORY_LIMIT &&
      (facts.rows ?? 0) >= ENUM_LIKE_MIN_ROWS),
  "identifier-like": (facts) =>
    (facts.rows ?? 0) > 0 &&
    ValueOf(facts.profile.nulls) === 0 &&
    ValueOf(facts.profile.distinct) === facts.rows,
  "label-candidate": (facts) => {
    const filled = Filled(facts) ?? 0;
    const distinct = ValueOf(facts.profile.distinct) ?? 0;
    const length = ValueOf(facts.profile.length);
    return (
      IsText(facts.column) &&
      filled > 0 &&
      distinct >= LABEL_DISTINCT_SHARE * filled &&
      length !== undefined &&
      length.avg <= LABEL_MAX_LENGTH
    );
  },
  "time-axis": (facts) => {
    const range = ValueOf(facts.profile.range);
    return (
      facts.column.kind.kind === "timestamp" &&
      range !== undefined &&
      (Filled(facts) ?? 0) >=
        TIME_AXIS_FILLED_SHARE * (facts.rows ?? Infinity) &&
      MonthsSpanned(range) >= TIME_AXIS_MIN_MONTHS
    );
  },
  measure: (facts) =>
    facts.column.kind.kind === "float" &&
    !facts.roles.keys.has(facts.column.name) &&
    !facts.roles.references.has(facts.column.name),
};

function IsTrait(name: string): name is ColumnTrait {
  return Object.hasOwn(TRAIT_RULES, name);
}

function TraitsOf(facts: TraitFacts): ColumnTrait[] {
  return Object.keys(TRAIT_RULES)
    .filter(IsTrait)
    .filter((trait) => TRAIT_RULES[trait](facts));
}

export async function ProfileColumn(
  session: MeasureSession,
  column: ProfiledColumn,
  source: Source,
  rows: number | undefined,
  roles: ColumnRoles,
): Promise<ColumnProfile> {
  const base = await MeasureBase(session, column, source);
  const distinct = await MeasureDistinct(session, column, source);
  const categories = await MeasureCategories(
    session,
    column,
    source,
    ValueOf(distinct),
  );
  const months = await MeasureMonths(session, column, source);
  const profile: ColumnProfile = { name: column.name, ...base, traits: [] };
  if (distinct) {
    profile.distinct = distinct;
  }
  if (categories) {
    profile.categories = categories;
  }
  if (months) {
    profile.months = months;
  }
  profile.traits = TraitsOf({ column, profile, rows, roles });
  return profile;
}
