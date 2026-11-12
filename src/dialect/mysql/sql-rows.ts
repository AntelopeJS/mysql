import type { RowSyntax } from "../sql-types";
import { type Sql, ident, int, join, lit, param, sql } from "../../statement";
import { type Flavour, type Held, HeldRead } from "./flavour";

/** `OFFSET` needs a `LIMIT`, and the largest one the server takes stands for none. */
const NO_LIMIT = sql`18446744073709551615`;

const COMMA = sql`, `;

/** The alias of the `JSON_TABLE` inside a listed table, which no other block can see. */
const LISTED_ALIAS = "listed";

/**
 * An equality on an index's leading column makes MySQL read a joined table by `ref` access, which
 * it never hash joins, so a join no index can look up reads every row of the value once per row of
 * the other side. A closed range names the same rows, since every table compares in a binary
 * collation that pads nothing, and is read once by a range scan and hash joined.
 */
function Limit(
  count: number | undefined,
  offset: number | undefined,
): Sql | undefined {
  if (count === undefined && offset === undefined) {
    return undefined;
  }
  const limit = count === undefined ? NO_LIMIT : param(count);
  return offset === undefined
    ? sql`LIMIT ${limit}`
    : sql`LIMIT ${limit} OFFSET ${param(offset)}`;
}

function JoinScope(column: Sql, value: Sql, lookup: boolean): Sql {
  return lookup
    ? sql`(${column} = ${value})`
    : sql`(${column} >= ${value} AND ${column} <= ${value})`;
}

/**
 * A lookup is joined laterally where the engine can, which reads it once per row like a scalar
 * subquery but lets the plan see it; MariaDB has no lateral join and reads it inline.
 */
function Lookup(flavour: Flavour): RowSyntax["lookup"] {
  if (!flavour.lateral) {
    return (subselect) => ({ value: sql`(${subselect})` });
  }
  return (subselect, alias, column) => ({
    join: sql`LEFT JOIN LATERAL (${subselect}) AS ${ident(alias)} ON TRUE`,
    value: sql`${ident(alias)}.${ident(column)}`,
  });
}

/**
 * The rows read from one bound JSON list, each column given the binary collation, since a column of
 * `JSON_TABLE` otherwise takes the connection's. MySQL refuses a `JSON_TABLE` in a locking read,
 * since it cannot lock the table function's rows, but not one inside a derived table there.
 */
function Listed(flavour: Flavour): RowSyntax["listed"] {
  return (rows, columns) => {
    const defined = columns.map(
      (column, position) =>
        sql`${ident(column.name)} VARCHAR(${int(column.chars)}) COLLATE ${ident(flavour.binaryCollation)} PATH ${lit(`$[${position}]`)}`,
    );
    const names = columns.map((column) => ident(column.name));
    return sql`(SELECT ${join(names, COMMA)} FROM JSON_TABLE(${param(JSON.stringify(rows))}, '$[*]' COLUMNS (${join(defined, COMMA)})) AS ${ident(LISTED_ALIAS)})`;
  };
}

export function RowsOf(flavour: Flavour): RowSyntax {
  return {
    nullSafeEqual: (left, right) => sql`(${left} <=> ${right})`,
    limit: Limit,
    materialize: (alias) => sql`/*+ NO_MERGE(${ident(alias)}) */`,
    lookup: Lookup(flavour),
    joinScope: JoinScope,
    listed: Listed(flavour),
    returning: flavour.returning,
    hold: (value, alias) => {
      const held: Held = { name: "value", value, kind: "json" };
      return {
        from: flavour.hold([held]),
        value: HeldRead(flavour, alias, held),
      };
    },
  };
}
