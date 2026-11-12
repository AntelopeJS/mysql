import type { RowSyntax } from "../sql-types";
import { type Sql, ident, param, sql } from "../../statement";

/** `OFFSET` needs a `LIMIT`, and the largest one the server takes stands for none. */
const NO_LIMIT = sql`18446744073709551615`;

/**
 * An equality on an index's leading column makes MySQL read a joined table by `ref` access, which
 * it never hash joins, so a join no index can look up reads every row of the value once per row of
 * the other side. A closed range names the same rows, since every table compares in a binary
 * collation that pads nothing, and is read once by a range scan and hash joined.
 */
function JoinScope(column: Sql, value: Sql, lookup: boolean): Sql {
  return lookup
    ? sql`(${column} = ${value})`
    : sql`(${column} >= ${value} AND ${column} <= ${value})`;
}

export const rows: RowSyntax = {
  nullSafeEqual: (left, right) => sql`(${left} <=> ${right})`,
  limit: (count, offset) => {
    if (count === undefined && offset === undefined) {
      return undefined;
    }
    const limit = count === undefined ? NO_LIMIT : param(count);
    return offset === undefined
      ? sql`LIMIT ${limit}`
      : sql`LIMIT ${limit} OFFSET ${param(offset)}`;
  },
  materialize: (alias) => sql`/*+ NO_MERGE(${ident(alias)}) */`,
  lookup: (subselect, alias, column) => ({
    join: sql`LEFT JOIN LATERAL (${subselect}) AS ${ident(alias)} ON TRUE`,
    value: sql`${ident(alias)}.${ident(column)}`,
  }),
  joinScope: JoinScope,
};
