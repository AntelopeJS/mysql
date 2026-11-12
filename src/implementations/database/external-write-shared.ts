import assert from "node:assert";

import type { Dialect } from "../../dialect";
import type { CheckedValue } from "../../dialect/external";
import { type Sql, ident, sql } from "../../statement";
import type { ExternalRelation } from "./fields";
import { KeylessRefusal } from "./external-refusals";
import { InvalidValues, type RefusedValue } from "./external-errors";
import { type Compiled, QualifiedColumn } from "./sql";
import type { ColumnDescriptor } from "./external-types";
import type { ExternalPayload, ExternalWriteMode } from "./external-payload";
import { WRITE_ALIAS, type WriteTarget } from "./writes-shared";
import { ClassifyMember, type Member } from "./member";

/**
 * One document an `insert` writes: the statement, the read that answers the row's `_id` in the
 * same transaction, and, for an upsert whose key the document names, the read that finds an
 * existing row and the update that replaces the insert when it does.
 */
export interface ExternalInsertRow {
  readonly insert: Sql;
  readonly readId: Sql;
  readonly upsert?: { readonly lock: Sql; readonly update?: Sql };
}

/**
 * What a write to an external relation compiles to: one statement answered by the rows it matched,
 * none for a write that names nothing to change, or the rows of an insert, run in one transaction.
 */
export type ExternalWrite =
  | { readonly kind: "count"; readonly statement?: Sql }
  | { readonly kind: "insert"; readonly rows: readonly ExternalInsertRow[] };

export function ExternalOf(target: WriteTarget): ExternalRelation {
  const { external } = target.origin.model;
  assert(external, "An external write needs the relation it targets");
  return external;
}

/** The key a write needs: a relation without one is read-only. */
export function RequireKey(target: WriteTarget): ColumnDescriptor[] {
  const external = ExternalOf(target);
  if (!external.key) {
    throw KeylessRefusal(external);
  }
  return external.key;
}

export function Table(external: ExternalRelation): Sql {
  return sql`${ident(external.schema)}.${ident(external.table)}`;
}

export function AliasedTable(external: ExternalRelation): Sql {
  return sql`${Table(external)} AS ${ident(WRITE_ALIAS)}`;
}

export function WriteColumn(column: string): Sql {
  return QualifiedColumn(WRITE_ALIAS, column);
}

/** `_id` as a read of the written row answers it: the key's text, a JSON array for a wide key. */
export function IdOfWrittenRow(
  dialect: Dialect,
  key: readonly ColumnDescriptor[],
): Sql {
  const parts = key.map((part) => part.value(WriteColumn(part.column)));
  return parts.length === 1
    ? parts[0]
    : dialect.external.types.compositeId(parts);
}

/** A value brought into its column's type, for a column a write may assign. */
export function Written(descriptor: ColumnDescriptor, value: Compiled): Sql {
  assert(descriptor.writing, `Column \`${descriptor.column}\` has no writing`);
  return descriptor.writing(value.sql);
}

/** A constant a check can read, or nothing for a value only the statement computes. */
function CheckedOf(raw: Member): CheckedValue | undefined {
  switch (raw.kind) {
    case "text":
    case "number":
    case "boolean":
    case "date":
      return raw;
    default:
      return undefined;
  }
}

interface ValueCheck {
  path: string;
  field: string;
  descriptor: ColumnDescriptor;
  raw: Member;
}

function CheckOf(
  external: ExternalRelation,
  field: string,
  descriptor: ColumnDescriptor,
  raw: Member,
): ValueCheck {
  return {
    path: `${external.schema}.${external.table}.${field}`,
    field,
    descriptor,
    raw,
  };
}

/** The constants a write must check: its assignments, and on insert the key it names. */
function ChecksOf(
  external: ExternalRelation,
  payload: ExternalPayload,
  mode: ExternalWriteMode,
): ValueCheck[] {
  const checks = payload.assignments.flatMap((assignment) =>
    assignment.raw === undefined
      ? []
      : [
          CheckOf(
            external,
            assignment.field,
            assignment.descriptor,
            assignment.raw,
          ),
        ],
  );
  if (mode !== "insert") {
    return checks;
  }
  for (const asserted of payload.asserted.values()) {
    const column = asserted.descriptor.column;
    const raw = ClassifyMember(asserted.raw);
    checks.push(CheckOf(external, column, asserted.descriptor, raw));
  }
  for (const claim of payload.keyFields) {
    checks.push(CheckOf(external, claim.field, claim.descriptor, claim.raw));
  }
  return checks;
}

/**
 * Refuses the write, naming every field, when any constant fails its column's check; nothing has
 * run yet. The server's strict mode refuses most such values itself, but rounds some silently.
 */
export function Validate(
  external: ExternalRelation,
  payload: ExternalPayload,
  mode: ExternalWriteMode,
): void {
  const refused: RefusedValue[] = ChecksOf(external, payload, mode).flatMap(
    (check) => {
      const value = CheckedOf(check.raw);
      const reason =
        value === undefined ? undefined : check.descriptor.check?.(value);
      return reason === undefined
        ? []
        : [
            {
              field: check.field,
              message: `Field '${check.path}' cannot hold ${check.raw.json()}: ${reason}`,
            },
          ];
    },
  );
  if (refused.length > 0) {
    throw InvalidValues(refused);
  }
}
