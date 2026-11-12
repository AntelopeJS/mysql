import type { Dialect } from "../../dialect";
import { type Sql, join, sql } from "../../statement";
import { Text } from "./readings";
import { IsNullJson } from "./value";
import { IsOpaque } from "./types";
import {
  type Compiled,
  Equal,
  type Equality,
  type ValueReference,
} from "./sql";

const AND = sql` AND `;

/**
 * A key a caller looks a value of no declared type up by, as the value key holds it.
 *
 * - `ordered`: a string or a date, held by the text column under the strings' tag, or a number or
 *   a boolean, held by the number column where the text column holds its kind's tag alone.
 * - `region`: an object or an array, whose values lie between their kind's tag and the next one.
 * - `null`: a null, which the text column holds as NULL and the number column as 0.
 */
export type RankedKey =
  | {
      readonly kind: "ordered";
      readonly rank: number;
      readonly pins: readonly Equality[];
      readonly column: Sql;
      readonly held: Sql;
      /** The column holds the first characters of a value only, so a bound through it ties with longer ones. */
      readonly prefix: boolean;
    }
  | { readonly kind: "region"; readonly rank: number }
  | { readonly kind: "null" };

function Textual(
  dialect: Dialect,
  reference: ValueReference,
  text: Sql,
): RankedKey {
  const json = dialect.sql.json;
  const fit = reference.key.text.fit;
  const tagged = json.tagged(json.ranks.string, text);
  const prefix = fit.kind === "prefix";
  return {
    kind: "ordered",
    rank: json.ranks.string,
    pins: [],
    column: reference.text,
    held: prefix ? dialect.sql.scalar.left(tagged, fit.width) : tagged,
    prefix,
  };
}

function Numeric(
  dialect: Dialect,
  reference: ValueReference,
  rank: number,
  value: Sql,
): RankedKey {
  return {
    kind: "ordered",
    rank,
    pins: [{ column: reference.text, value: dialect.sql.json.tagged(rank) }],
    column: reference.number,
    held: value,
    prefix: false,
  };
}

/**
 * A caller's key as a value key holds it, by the kind it decoded to: a date as the ISO text an
 * undeclared value stores it as. Nothing for a key whose kind only the statement knows.
 */
export function RankedKeyOf(
  dialect: Dialect,
  reference: ValueReference,
  key: Compiled,
): RankedKey | undefined {
  const ranks = dialect.sql.json.ranks;
  if (IsNullJson(dialect, key)) {
    return { kind: "null" };
  }
  switch (key.type.kind) {
    case "text":
      return Textual(dialect, reference, key.sql);
    case "timestamp":
      return Textual(dialect, reference, Text(dialect, key).sql);
    case "float":
      return Numeric(dialect, reference, ranks.number, key.sql);
    case "bool":
      return Numeric(dialect, reference, ranks.boolean, key.sql);
    case "array":
      return { kind: "region", rank: ranks.array };
    case "json":
      return IsOpaque(key.type)
        ? undefined
        : { kind: "region", rank: ranks.object };
  }
}

/**
 * The equalities that hold on every row whose value equals the key, where equalities can say it:
 * not for an object, an array or a null, which the rows' values decide alone.
 */
export function RankedEqualities(ranked: RankedKey): Equality[] | undefined {
  return ranked.kind === "ordered"
    ? [...ranked.pins, { column: ranked.column, value: ranked.held }]
    : undefined;
}

/** An upper bound through a prefix may not exclude a value its prefix ties with, so it is inclusive. */
function Below(ranked: Extract<RankedKey, { kind: "ordered" }>): Sql {
  return ranked.prefix ? sql`<=` : sql`<`;
}

/**
 * The rows whose value is at least the key, in JSON's order: on the key's side of it within its
 * kind, and every value of a later kind, which a tagged text bound covers by itself. Nothing narrows
 * a null, which every value is at least.
 */
function Lower(
  dialect: Dialect,
  reference: ValueReference,
  low: RankedKey,
): Sql | undefined {
  const json = dialect.sql.json;
  switch (low.kind) {
    case "null":
      return undefined;
    case "region":
      return sql`${reference.text} >= ${json.tagged(low.rank)}`;
    case "ordered":
      return low.pins.length === 0
        ? sql`${low.column} >= ${low.held}`
        : sql`((${Equal(low.pins)} AND ${low.column} >= ${low.held}) OR ${reference.text} > ${json.tagged(low.rank)})`;
  }
}

/** The rows whose value is below the key, in JSON's order: none below a null. */
function Upper(
  dialect: Dialect,
  reference: ValueReference,
  high: RankedKey,
): Sql {
  const json = dialect.sql.json;
  switch (high.kind) {
    case "null":
      return sql`FALSE`;
    case "region":
      return sql`${reference.text} < ${json.tagged(high.rank + 1)}`;
    case "ordered":
      return high.pins.length === 0
        ? sql`${high.column} ${Below(high)} ${high.held}`
        : sql`((${Equal(high.pins)} AND ${high.column} < ${high.held}) OR ${reference.text} < ${json.tagged(high.rank)})`;
  }
}

/**
 * The rows a half-open range of keys can hold, through a value key. Two bounds of one kind narrow
 * to one range of the column that orders it; bounds of two kinds keep every value of a kind ranked
 * between them. A null is below every value, so a range from a null keeps the nulls, whose text is
 * NULL. The comparison of the values themselves decides the rows.
 */
export function RankedRange(
  dialect: Dialect,
  reference: ValueReference,
  low: RankedKey,
  high: RankedKey,
): Sql {
  if (
    low.kind === "ordered" &&
    high.kind === "ordered" &&
    low.rank === high.rank
  ) {
    const pins = low.pins.length > 0 ? [Equal(low.pins)] : [];
    return sql`(${join(
      [
        ...pins,
        sql`${low.column} >= ${low.held}`,
        sql`${high.column} ${Below(high)} ${high.held}`,
      ],
      AND,
    )})`;
  }
  const upper = Upper(dialect, reference, high);
  const below =
    low.kind === "null" ? sql`(${upper} OR ${reference.text} IS NULL)` : upper;
  const lower = Lower(dialect, reference, low);
  return lower ? sql`(${lower} AND ${below})` : sql`(${below})`;
}
