import type { SqlSyntax } from "../types";
import { type Sql, ident, sql } from "../../statement";
import type { SqlType } from "../../implementations/database/types";

/**
 * Text is unbounded and never indexed directly: an index reaches it through a generated key column.
 * A boolean is `TINYINT(1)`, read back as a boolean by its `SqlType`. A date keeps microseconds and
 * is UTC because every session is. Lists and documents are `JSON`.
 */
const PHYSICAL_TYPES: Record<SqlType["kind"], Sql> = {
  text: sql`LONGTEXT`,
  float: sql`DOUBLE`,
  bool: sql`TINYINT(1)`,
  timestamp: sql`DATETIME(6)`,
  array: sql`JSON`,
  json: sql`JSON`,
};

export const sqlCore: Pick<SqlSyntax, "quote" | "physical"> = {
  quote: ident,
  physical: (type) => PHYSICAL_TYPES[type.kind],
};
