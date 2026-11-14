import type { JsonKind } from "../sql-types";
import { type Sql, join, lit, sql } from "../../statement";

/** What `JSON_TYPE` answers for each kind; a JSON number has four. */
const TYPE_NAMES: Record<JsonKind, readonly string[]> = {
  object: ["OBJECT"],
  array: ["ARRAY"],
  string: ["STRING"],
  number: ["INTEGER", "UNSIGNED INTEGER", "DOUBLE", "DECIMAL"],
  boolean: ["BOOLEAN"],
  null: ["NULL"],
};

/**
 * A type name as `JSON_TYPE` answers it. The server gives the text its JSON functions answer the
 * `utf8mb4_bin` collation, and a literal would otherwise take the session's, which cannot be
 * compared with it.
 */
function TypeLiteral(name: string): Sql {
  return sql`${lit(name)} COLLATE utf8mb4_bin`;
}

/** Whether a JSON value is of one of `kinds`. */
export function Is(value: Sql, kinds: readonly JsonKind[]): Sql {
  const names = kinds.flatMap((kind) => TYPE_NAMES[kind]).map(TypeLiteral);
  return sql`(JSON_TYPE(${value}) IN (${join(names, sql`, `)}))`;
}

/** Text out of JSON, in the session collation every other text carries. */
export function Unquoted(value: Sql): Sql {
  return sql`CAST(JSON_UNQUOTE(${value}) AS CHAR)`;
}
