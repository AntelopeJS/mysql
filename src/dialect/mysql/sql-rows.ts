import type { RowSyntax } from "../sql-types";
import { ident, param, sql } from "../../statement";

/** `OFFSET` needs a `LIMIT`, and the largest one the server takes stands for none. */
const NO_LIMIT = sql`18446744073709551615`;

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
};
