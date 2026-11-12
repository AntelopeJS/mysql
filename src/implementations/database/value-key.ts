import type { Dialect } from "../../dialect";
import type { JsonKind } from "../../dialect/sql-types";
import { sql } from "../../statement";
import type { KeyColumn, ValueKey } from "./paths";
import { type KeyReference, QualifiedColumn, type ValueReference } from "./sql";

/** The typed reads a comparison makes of a value of no declared type. */
type TypedRead = Extract<KeyColumn["read"], "string" | "double" | "bool">;

/** The kind of value each typed read reads, which a value key holds under that kind's tag. */
const READ_KINDS: Record<TypedRead, JsonKind> = {
  string: "string",
  double: "number",
  bool: "boolean",
};

function SamePath(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}

/** An exact text key holds the whole value, so it is preferred; among prefixes the widest is. */
function Width(key: ValueKey): number {
  const fit = key.text.fit;
  return fit.kind === "exact" ? Number.MAX_SAFE_INTEGER : fit.width;
}

/** The value key at a row's alias over `source` at `path`, if a declared index made one. */
export function ValueKeyAt(
  alias: string,
  keys: readonly ValueKey[],
  source: string,
  path: readonly string[],
): ValueReference | undefined {
  const best = keys
    .filter(
      (key) => key.text.source === source && SamePath(key.text.path, path),
    )
    .sort((left, right) => Width(right) - Width(left))[0];
  return best && ValueReferenceOf(alias, best);
}

/** A value key's columns at the alias of the row they belong to. */
export function ValueReferenceOf(alias: string, key: ValueKey): ValueReference {
  return {
    text: QualifiedColumn(alias, key.text.name),
    number: QualifiedColumn(alias, key.number.name),
    key,
  };
}

/**
 * A typed read of the value a value key holds, as the key column a comparison of that read is
 * served by: a string through the text column, its operand tagged as strings are; a number or a
 * boolean through the number column, pinned to its kind by the tag the text column holds for it.
 * The value is absent, and a default stands in for it, where the text column is NULL: on an absent
 * value and on a null.
 */
export function ValueKeyRead(
  dialect: Dialect,
  reference: ValueReference,
  read: TypedRead,
): KeyReference {
  const json = dialect.sql.json;
  const rank = json.ranks[READ_KINDS[read]];
  const absent = sql`${reference.text} IS NULL`;
  if (read === "string") {
    return {
      column: reference.text,
      key: reference.key.text,
      rows: "every",
      pins: [],
      tag: rank,
      absent,
    };
  }
  return {
    column: reference.number,
    key: reference.key.number,
    rows: "every",
    pins: [{ column: reference.text, value: json.tagged(rank) }],
    absent,
  };
}
