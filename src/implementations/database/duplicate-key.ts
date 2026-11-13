import { DuplicateKeyError } from "@antelopejs/interface-database";

import type { Dialect } from "../../dialect";
import { ID_COLUMN } from "./utils";
import type { IndexPlan } from "./plan";
import { KeyColumnsOf, type KeyPart, TextCapacity } from "./paths";
import type { TableOrigin } from "./relation";
import type { UnbuiltCause, UnbuiltUniqueIndex } from "./unbuilt-unique";

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
      if (part.kind === "instance") {
        continue;
      }
      const key = KeyColumnsOf(part).find((one) => one.name === column);
      if (!key) {
        continue;
      }
      const width = TextCapacity(key);
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

/** The stored columns a key part reads: its own column, or the one its generated key column derives from. */
function PartSources(part: KeyPart): string[] {
  switch (part.kind) {
    case "key":
      return [part.key.source];
    case "value":
      return [part.key.text.source, part.key.number.source];
    default:
      return [part.column];
  }
}

/** Why the index phase left a unique index unbuilt, as a write refused over it says. */
const BECAUSE: Record<UnbuiltCause, string> = {
  refused: "the server refused it",
  locked: "a transaction holds the table",
};

/** What builds a unique index the phase left unbuilt, as a write refused over it says. */
const REMEDY: Record<UnbuiltCause, string> = {
  refused: "Remove the rows it refuses, then register the schema again",
  locked:
    "It is built once that transaction ends, and the write can be run again then",
};

/**
 * Refuses a write that stores a value in a column a refused unique index of its table keys on, as
 * every insert does: with the index unbuilt, the server would store the duplicate it exists to
 * refuse. A write that sets none of those columns, a delete included, cannot add a duplicate and
 * goes through.
 */
export function RefuseUnbuiltUnique(
  refused: readonly UnbuiltUniqueIndex[],
  origin: TableOrigin,
  sets: readonly string[],
): void {
  const written = new Set(sets);
  const covering = refused.find(
    (one) =>
      one.tableId === origin.tableId &&
      one.index.parts.some((part) =>
        PartSources(part).some((column) => written.has(column)),
      ),
  );
  if (covering) {
    const table = `${origin.schemaId}.${origin.tableId}`;
    throw new Error(
      `Write refused: unique index '${covering.index.id}' on '${table}' is not built, because ${BECAUSE[covering.cause]} (${covering.reason}), so a write that adds rows or sets ${IndexedFields(covering.index).join(", ")} could store the duplicate it exists to refuse. ${REMEDY[covering.cause]}`,
    );
  }
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
