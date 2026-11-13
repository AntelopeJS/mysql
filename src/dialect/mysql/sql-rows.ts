import type { RowSyntax } from "../sql-types";
import { type Sql, ident, param, sql } from "../../statement";
import { type Flavour, type Held, HeldRead } from "./flavour";

/** `OFFSET` needs a `LIMIT`, and the largest one the server takes stands for none. */
const NO_LIMIT = sql`18446744073709551615`;

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
 * MariaDB merges a derived table that holds no row bound, and 11.8 ignores the `NO_MERGE` hint, so
 * a bound that keeps every row keeps it unmerged.
 */
function Unmerged(select: Sql): Sql {
  return sql`${select} LIMIT ${NO_LIMIT}`;
}

export function RowsOf(flavour: Flavour): RowSyntax {
  const rows: RowSyntax = {
    nullSafeEqual: (left, right) => sql`(${left} <=> ${right})`,
    limit: Limit,
    materialize: (alias) => sql`/*+ NO_MERGE(${ident(alias)}) */`,
    lookup: Lookup(flavour),
    joinScope: JoinScope,
    nestedLoopJoin: flavour.nestedLoopJoin !== undefined,
    returning: flavour.returning,
    hold: (value, alias) => {
      const held: Held = { name: "value", value, kind: "json" };
      return {
        from: flavour.hold([held]),
        value: HeldRead(flavour, alias, held),
      };
    },
  };
  const nestedLoop = flavour.nestedLoopJoin;
  return nestedLoop
    ? {
        ...rows,
        keyedJoin: { unmerged: Unmerged, jsonHash: nestedLoop.jsonHash },
      }
    : rows;
}
