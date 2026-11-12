import assert from "node:assert";
import type { QueryStage } from "@antelopejs/interface-database/common";

import { type Sql, ident, join, sql } from "../../statement";
import type { DecodingContext } from "./context";
import type { ExternalRelation } from "./fields";
import { ID_COLUMN, OptionsOf } from "./utils";
import { RelationName } from "./external-refusals";
import {
  type ColumnDescriptor,
  IsReadOnly,
  ReadOnlyReason,
} from "./external-types";
import {
  type AssertedKey,
  type ExternalPayload,
  KeyFieldValue,
  KeyValue,
  SplitExternalPayload,
} from "./external-payload";
import {
  AliasedTable,
  type ExternalInsertRow,
  type ExternalWrite,
  ExternalOf,
  IdOfWrittenRow,
  RequireKey,
  Table,
  Validate,
  WriteColumn,
  Written,
} from "./external-write-shared";
import { InsertedDocuments, type WriteTarget } from "./writes-shared";
import { IsString } from "./guards";

const CONFLICT_MODES: readonly string[] = ["update", "replace"];
const AND = sql` AND `;
const COMMA = sql`, `;

/** The value the server gave the key column the last single-row `INSERT` on the session left out. */
const GENERATED_KEY = sql`LAST_INSERT_ID()`;

type Conflict = "update" | "replace";

function IsConflict(value: string): value is Conflict {
  return CONFLICT_MODES.includes(value);
}

function ConflictOf(stage: QueryStage): Conflict | undefined {
  const conflict: unknown = OptionsOf(stage)?.conflict;
  if (conflict === undefined || conflict === null) {
    return undefined;
  }
  assert(
    IsString(conflict) && IsConflict(conflict),
    `The '${stage.stage}' stage takes a conflict mode of ${CONFLICT_MODES.join(" or ")}, received ${JSON.stringify(conflict)}`,
  );
  return conflict;
}

function ReadOnlyKey(external: ExternalRelation, asserted: AssertedKey): Error {
  return new Error(
    `Payload of '${external.schema}.${external.table}' gives key column \`${asserted.descriptor.column}\` a value through '${asserted.claimedBy}', but it is ${ReadOnlyReason(asserted.descriptor)}, which the database fills`,
  );
}

function UnreportedKey(
  external: ExternalRelation,
  part: ColumnDescriptor,
): Error {
  return new Error(
    `Key column \`${part.column}\` of ${RelationName(external)} has no value in the payload: give it one, since only an AUTO_INCREMENT key is answered back after an insert`,
  );
}

interface InsertedColumn {
  column: string;
  value: Sql;
}

function InsertedColumns(
  external: ExternalRelation,
  payload: ExternalPayload,
  context: DecodingContext,
): InsertedColumn[] {
  const keyed = [...payload.asserted.values()].map((asserted) => {
    if (IsReadOnly(asserted.descriptor)) {
      throw ReadOnlyKey(external, asserted);
    }
    return {
      column: asserted.descriptor.column,
      value: Written(asserted.descriptor, KeyValue(asserted, context)),
    };
  });
  const keyFields = payload.keyFields.map((claim) => ({
    column: claim.descriptor.column,
    value: Written(claim.descriptor, KeyFieldValue(claim, context)),
  }));
  const fields = payload.assignments.map((assignment) => ({
    column: assignment.descriptor.column,
    value: Written(assignment.descriptor, assignment.value),
  }));
  return [...keyed, ...keyFields, ...fields];
}

/**
 * Each key column as the inserted row holds it: the value the payload wrote, or the key the server
 * generated. A key column neither gives is refused, since nothing reads it back.
 */
function KeyValues(
  external: ExternalRelation,
  key: ColumnDescriptor[],
  columns: InsertedColumn[],
): Map<string, Sql> {
  const written = new Map(
    columns.map((column) => [column.column, column.value]),
  );
  return new Map(
    key.map((part) => {
      const value = written.get(part.column);
      if (value) {
        return [part.column, value];
      }
      if (!part.autoIncrement) {
        throw UnreportedKey(external, part);
      }
      return [part.column, GENERATED_KEY];
    }),
  );
}

function KeyMatch(values: Map<string, Sql>): Sql {
  return join(
    [...values].map(
      ([column, value]) => sql`${WriteColumn(column)} = ${value}`,
    ),
    AND,
  );
}

/**
 * The assignments an upsert's existing row takes: `update` assigns what the payload names,
 * `replace` also resets every other writable declared field. Neither touches the key or a column
 * only the database writes.
 */
function UpsertSets(
  target: WriteTarget,
  key: ColumnDescriptor[],
  columns: InsertedColumn[],
  conflict: Conflict,
): Sql[] {
  const keyColumns = new Set(key.map((part) => part.column));
  const assigned = columns.filter((column) => !keyColumns.has(column.column));
  const sets = assigned.map(
    (column) => sql`${WriteColumn(column.column)} = ${column.value}`,
  );
  if (conflict === "replace") {
    const named = new Set(assigned.map((column) => column.column));
    for (const spec of Object.values(target.origin.model.fields)) {
      const descriptor = spec.native;
      assert(
        descriptor,
        "An external field needs the column it was resolved to",
      );
      if (
        !named.has(descriptor.column) &&
        !keyColumns.has(descriptor.column) &&
        !IsReadOnly(descriptor)
      ) {
        const cleared = descriptor.hasDefault ? sql`DEFAULT` : sql`NULL`;
        sets.push(sql`${WriteColumn(descriptor.column)} = ${cleared}`);
      }
    }
  }
  return sets;
}

function InsertStatement(
  external: ExternalRelation,
  columns: InsertedColumn[],
): Sql {
  const names = join(
    columns.map((column) => ident(column.column)),
    COMMA,
  );
  const values = join(
    columns.map((column) => column.value),
    COMMA,
  );
  return sql`INSERT INTO ${Table(external)} (${names}) VALUES (${values})`;
}

function InsertRow(
  target: WriteTarget,
  key: ColumnDescriptor[],
  columns: InsertedColumn[],
  conflict: Conflict | undefined,
  context: DecodingContext,
): ExternalInsertRow {
  const external = ExternalOf(target);
  const values = KeyValues(external, key, columns);
  const match = KeyMatch(values);
  const from = AliasedTable(external);
  const readId = sql`SELECT ${IdOfWrittenRow(context.dialect, key)} AS ${ident(ID_COLUMN)} FROM ${from} WHERE ${match}`;
  const insert = InsertStatement(external, columns);
  const returning = context.dialect.sql.rows.returning
    ? sql`${insert} RETURNING ${IdOfWrittenRow(context.dialect, key, ident)} AS ${ident(ID_COLUMN)}`
    : undefined;
  const supplied = [...values.values()].every(
    (value) => value !== GENERATED_KEY,
  );
  if (!conflict || !supplied) {
    return { insert, returning, readId };
  }
  const sets = UpsertSets(target, key, columns, conflict);
  return {
    insert,
    returning,
    readId,
    upsert: {
      lock: sql`SELECT 1 AS found FROM ${from} WHERE ${match} FOR UPDATE`,
      update:
        sets.length === 0
          ? undefined
          : sql`UPDATE ${from} SET ${join(sets, COMMA)} WHERE ${match}`,
    },
  };
}

/**
 * Inserts each document as its own statement, in one transaction, and answers the keys in input
 * order: the insert answers each row's `_id` where the engine has `RETURNING`, and on MySQL it is
 * read back right after the insert, by the key the payload gave or the one the server generated. A column a document leaves out takes its
 * `DEFAULT`. An upsert finds the row by its key, locking it, and updates it instead; a clash on
 * any other unique index still fails, as it would without the upsert.
 */
export function ExternalInsert(
  target: WriteTarget,
  stage: QueryStage,
  context: DecodingContext,
): ExternalWrite {
  const key = RequireKey(target);
  const external = ExternalOf(target);
  const conflict = ConflictOf(stage);
  const rows = InsertedDocuments(stage).map((document) => {
    const payload = SplitExternalPayload(
      document,
      target.origin.model,
      context,
      "insert",
    );
    Validate(external, payload, "insert");
    const columns = InsertedColumns(external, payload, context);
    return InsertRow(target, key, columns, conflict, context);
  });
  return { kind: "insert", rows };
}
