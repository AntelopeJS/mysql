import type { SqlSyntax } from "../types";
import { type Sql, ident, sql } from "../../statement";
import type { SqlType } from "../../implementations/database/types";
import type { Flavour } from "./flavour";

/**
 * Text is unbounded and never indexed directly: an index reaches it through a generated key column.
 * A boolean is `TINYINT(1)`, read back as a boolean by its `SqlType`. A date keeps microseconds and
 * is UTC because every session is. Lists and documents are the flavour's JSON type.
 */
function PhysicalTypes(flavour: Flavour): Record<SqlType["kind"], Sql> {
  return {
    text: sql`LONGTEXT`,
    float: sql`DOUBLE`,
    bool: sql`TINYINT(1)`,
    timestamp: sql`DATETIME(6)`,
    array: flavour.jsonType,
    json: flavour.jsonType,
  };
}

export function SqlCoreOf(
  flavour: Flavour,
): Pick<SqlSyntax, "quote" | "physical"> {
  const types = PhysicalTypes(flavour);
  return {
    quote: ident,
    physical: (type) => types[type.kind],
  };
}
