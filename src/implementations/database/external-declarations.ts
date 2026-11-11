import type { Dialect } from "../../dialect";
import type { CatalogColumn } from "../../dialect/external";
import { SCALAR_KINDS } from "./external-types";
import type { SqlType } from "./types";

const FIELD_TOKENS: Record<SqlType["kind"], string> = {
  text: "string",
  float: "number",
  bool: "boolean",
  timestamp: "date",
  json: "object",
  array: "any[]",
};

/** A declaration registration accepts for a column, as the `@Field` token and the parsed kind. */
export interface AcceptedDeclaration {
  declared: string;
  kind: SqlType;
  lossy?: string;
}

function ProposedFirst(
  kinds: readonly SqlType[],
  proposed: SqlType,
): SqlType[] {
  return [
    ...kinds.filter((kind) => kind.kind === proposed.kind),
    ...kinds.filter((kind) => kind.kind !== proposed.kind),
  ];
}

/**
 * Every declaration registration accepts for a column, the one a generator should propose first,
 * each with the reason it does not round-trip when it does not. The same policy registration reads
 * decides it, so a declaration listed here is one registration takes.
 */
export function AcceptedDeclarations(
  dialect: Dialect,
  column: CatalogColumn,
): AcceptedDeclaration[] {
  const types = dialect.external.types;
  const family = types.family(column);
  if (!family) {
    return [];
  }
  return ProposedFirst(SCALAR_KINDS, types.proposed(family)).flatMap((kind) => {
    const reading = types.reading(kind, column);
    return reading
      ? [{ declared: FIELD_TOKENS[kind.kind], kind, lossy: reading.lossy }]
      : [];
  });
}

/** Why no declaration reads a column, for a catalog that lists it anyway. */
export function UnsupportedReason(column: CatalogColumn): string {
  return `no field type reads a ${column.native} column`;
}
