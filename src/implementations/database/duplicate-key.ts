import { DuplicateKeyError } from "@antelopejs/interface-database";

import type { Dialect } from "../../dialect";
import { ID_COLUMN } from "./utils";
import type { IndexPlan } from "./plan";
import type { TableOrigin } from "./relation";

const PRIMARY_KEY = "primary";
const PRIMARY_KEY_FIELDS = [ID_COLUMN];
const TABLE_SEPARATOR = ".";

/** The fields an index keys on, `_instance` aside. */
function IndexedFields(index: IndexPlan): string[] {
  return index.parts.flatMap((part) =>
    part.kind === "instance" ? [] : [part.field],
  );
}

/**
 * The index a duplicate names. The server reports it as `<table>.<index>`, and both names may hold
 * the separator, so the table's own name is what is taken off the front.
 */
function ReportedIndex(key: string, table: string): string {
  const prefix = `${table}${TABLE_SEPARATOR}`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function DuplicateOf(origin: TableOrigin, key: string): Error | undefined {
  const name = ReportedIndex(key, origin.plan.table);
  if (name.toLowerCase() === PRIMARY_KEY) {
    return new DuplicateKeyError(ID_COLUMN, [...PRIMARY_KEY_FIELDS]);
  }
  const index = origin.plan.indexes.find(
    (planned) => planned.unique && planned.name === name,
  );
  return index && new DuplicateKeyError(index.id, IndexedFields(index));
}

/**
 * A value wider than the exact key column a unique index keys on, named by the field, the width
 * and the index rather than by the generated column the server reports.
 */
function TooLongFor(origin: TableOrigin, column: string): Error | undefined {
  for (const index of origin.plan.indexes) {
    for (const part of index.parts) {
      if (part.kind !== "key" || part.key.name !== column) {
        continue;
      }
      const width = "fit" in part.key ? part.key.fit.width : undefined;
      return new Error(
        `The value of '${part.field}' is longer than ${width ?? "the"} characters unique index '${index.id}' on '${origin.schemaId}.${origin.tableId}' can hold`,
      );
    }
  }
  return undefined;
}

/**
 * The error a write to a managed table answers when it failed: the interface's
 * `DuplicateKeyError` for a unique key the server refused the row for, matched against the table's
 * declared unique indexes and its primary key, which reports as `_id`; a value too wide for a
 * unique index's key, by its field; anything else unchanged.
 */
export function DuplicateKeyFailure(
  err: Error,
  origin: TableOrigin,
  dialect: Dialect,
): Error {
  const failure = dialect.errors.classify(err);
  if (failure.kind === "duplicate") {
    return DuplicateOf(origin, failure.key) ?? err;
  }
  if (failure.kind === "tooLong") {
    return TooLongFor(origin, failure.column) ?? err;
  }
  return err;
}

/** Whether a write failed on the primary key, which a select-then-write runs again after. */
export function IsPrimaryKeyDuplicate(
  err: Error,
  origin: TableOrigin,
  dialect: Dialect,
): boolean {
  const failure = dialect.errors.classify(err);
  return (
    failure.kind === "duplicate" &&
    ReportedIndex(failure.key, origin.plan.table).toLowerCase() === PRIMARY_KEY
  );
}
