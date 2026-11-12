import assert from "node:assert";
import { randomUUID } from "node:crypto";
import type { QueryStage } from "@antelopejs/interface-database/common";
import { DuplicateKeyError } from "@antelopejs/interface-database";

import type { Dialect } from "../../dialect";
import { type Sql, ident, join, sql } from "../../statement";
import type { TableOrigin } from "./relation";
import type { DecodingContext } from "./context";
import { type Compiled, QualifiedColumn, TextParam } from "./sql";
import { DeclaredColumns, PhysicalOrder, type TableModel } from "./fields";
import { EXTRA_COLUMN, ID_COLUMN, INSTANCE_COLUMN, OptionsOf } from "./utils";
import {
  ID_AS_KEY,
  MembersByColumn,
  NULL_VALUE,
  NoIdSupplied,
  type OverflowMembers,
  type PayloadOptions,
  SplitPayload,
} from "./payload";
import {
  Assignment,
  InsertedDocuments,
  MergeExtra,
  RequireInstance,
  WRITE_ALIAS,
  type WriteCompiler,
  WriteTable,
} from "./writes-shared";
import type { DocumentView } from "./member";

const INSERTED: PayloadOptions = { id: ID_AS_KEY };
const COMMA = sql`, `;

/**
 * What an existing row does with the document that named its key. The two modes differ in which
 * columns the row's `UPDATE` names and in whether the overflow document is merged or replaced.
 */
type ConflictMode = "update" | "replace";

const CONFLICT_MODES: readonly ConflictMode[] = ["update", "replace"];

function IsConflictMode(mode: unknown): mode is ConflictMode {
  return CONFLICT_MODES.some((known) => known === mode);
}

function ConflictModeOf(stage: QueryStage): ConflictMode | undefined {
  const conflict: unknown = OptionsOf(stage)?.conflict;
  if (conflict === undefined || conflict === null) {
    return undefined;
  }
  assert(
    IsConflictMode(conflict),
    `The '${stage.stage}' stage takes a conflict mode of ${CONFLICT_MODES.join(" or ")}, received ${JSON.stringify(conflict)}`,
  );
  return conflict;
}

interface InsertRow {
  id: string;
  key: Compiled;
  values: Map<string, Compiled>;
  extra?: OverflowMembers;
}

/** The key a document supplies, if it supplies one at all; `insert` answers the id it wrote. */
function SuppliedId(document: DocumentView): string | undefined {
  const supplied = document.own(ID_COLUMN);
  if (supplied === undefined || NoIdSupplied(supplied)) {
    return undefined;
  }
  assert(
    supplied.kind === "text",
    `An inserted document's '${ID_COLUMN}' must be a string, received ${supplied.kind}`,
  );
  return supplied.value;
}

/** One document, compiled into the pieces a row is assembled from, keyed by a known id. */
function InsertRowOf(
  document: DocumentView,
  model: TableModel,
  context: DecodingContext,
): InsertRow {
  const supplied = SuppliedId(document);
  const id = supplied ?? randomUUID();
  const split = SplitPayload(document, model, context, INSERTED);
  const values = MembersByColumn(split);
  const key = values.get(ID_COLUMN) ?? TextParam(context.dialect, id);
  values.delete(ID_COLUMN);
  return { id, key, values, extra: split.extra };
}

/** The declared columns some row of the batch writes, in the order the table declares them. */
function BatchColumns(model: TableModel, rows: readonly InsertRow[]): string[] {
  return DeclaredColumns(model).filter((column) =>
    rows.some((row) => row.values.has(column)),
  );
}

/** Everything one batch's statements share, whichever rows each of them writes. */
interface InsertPlan {
  dialect: Dialect;
  origin: TableOrigin;
  instance: Sql;
}

/**
 * One row's values, naming the batch's columns rather than its own, since widths must match. The
 * overflow column is `NOT NULL`, so a row with no undeclared keys writes an empty document.
 */
function RowTuple(plan: InsertPlan, row: InsertRow, columns: string[]): Sql {
  const declared = columns.map(
    (column) => row.values.get(column)?.sql ?? NULL_VALUE,
  );
  const values = PhysicalOrder(
    row.key.sql,
    plan.instance,
    declared,
    row.extra?.document.sql ?? plan.dialect.sql.json.emptyObject,
  );
  return sql`(${join(values, COMMA)})`;
}

/** One `INSERT` of the rows given, naming exactly the columns those rows write. */
function InsertStatement(plan: InsertPlan, rows: readonly InsertRow[]): Sql {
  const columns = BatchColumns(plan.origin.model, rows);
  const named = PhysicalOrder(
    ID_COLUMN,
    INSTANCE_COLUMN,
    columns,
    EXTRA_COLUMN,
  ).map((column) => ident(column));
  const tuples = rows.map((row) => RowTuple(plan, row, columns));
  return sql`INSERT INTO ${ident(plan.origin.plan.table)} (${join(named, COMMA)}) VALUES ${join(tuples, COMMA)}`;
}

/**
 * Refuses a batch naming one key twice under a conflict mode, before any statement runs: which of
 * the two documents the row would end up holding is not something a caller can mean.
 */
function AssertDistinctIds(rows: readonly InsertRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) {
      throw new DuplicateKeyError(ID_COLUMN, [ID_COLUMN]);
    }
    seen.add(row.id);
  }
}

/** Reads which of the batch's keys exist in the instance, and holds them until the transaction ends. */
function LockStatement(plan: InsertPlan, rows: readonly InsertRow[]): Sql {
  const id = QualifiedColumn(WRITE_ALIAS, ID_COLUMN);
  const instance = QualifiedColumn(WRITE_ALIAS, INSTANCE_COLUMN);
  const keys = join(
    rows.map((row) => row.key.sql),
    COMMA,
  );
  return sql`SELECT ${id} AS ${ident(ID_COLUMN)} FROM ${WriteTable(plan.origin)} WHERE ${instance} = ${plan.instance} AND ${id} IN (${keys}) FOR UPDATE`;
}

/**
 * The assignments an existing row takes. `update` names the columns the document wrote and merges
 * its undeclared keys into the row's own; `replace` names every declared column, NULL where the
 * document is silent, and writes the overflow document whole.
 */
function ConflictAssignments(
  plan: InsertPlan,
  row: InsertRow,
  mode: ConflictMode,
): Sql[] {
  const model = plan.origin.model;
  const json = plan.dialect.sql.json;
  if (mode === "replace") {
    const declared = DeclaredColumns(model).map((column) =>
      Assignment(column, row.values.get(column)?.sql ?? NULL_VALUE),
    );
    const extra = row.extra?.document.sql ?? json.emptyObject;
    return [...declared, Assignment(EXTRA_COLUMN, extra)];
  }
  const declared = BatchColumns(model, [row]).map((column) =>
    Assignment(column, row.values.get(column)?.sql ?? NULL_VALUE),
  );
  return [
    ...declared,
    Assignment(EXTRA_COLUMN, MergeExtra(plan.dialect, row.extra)),
  ];
}

function UpdateStatement(
  plan: InsertPlan,
  row: InsertRow,
  mode: ConflictMode,
): Sql {
  const id = QualifiedColumn(WRITE_ALIAS, ID_COLUMN);
  const instance = QualifiedColumn(WRITE_ALIAS, INSTANCE_COLUMN);
  const assignments = join(ConflictAssignments(plan, row, mode), COMMA);
  return sql`UPDATE ${WriteTable(plan.origin)} SET ${assignments} WHERE ${instance} = ${plan.instance} AND ${id} = ${row.key.sql}`;
}

/**
 * Writes new rows, and answers their keys in input order. Every key is known before a statement
 * runs, supplied or generated, so nothing is read back.
 *
 * With a conflict mode the batch becomes a select-then-write transaction: the keys that exist are
 * locked and updated row by row, and the rest are inserted. Only the primary key is a conflict
 * target, as it is by construction here; `ON DUPLICATE KEY UPDATE` is not used, since it fires on
 * any unique key and would rewrite the other row a secondary index collided with.
 */
export const InsertWrite: WriteCompiler = (target, stage, context) => {
  const instance = RequireInstance(target, stage);
  const documents = InsertedDocuments(stage);
  if (documents.length === 0) {
    return { kind: "insert", ids: [], statements: [] };
  }
  const plan: InsertPlan = {
    dialect: context.dialect,
    origin: target.origin,
    instance: instance.sql,
  };
  const mode = ConflictModeOf(stage);
  const rows = documents.map((document) =>
    InsertRowOf(document, target.origin.model, context),
  );
  const ids = rows.map((row) => row.id);
  if (!mode) {
    return { kind: "insert", ids, statements: [InsertStatement(plan, rows)] };
  }
  AssertDistinctIds(rows);
  return {
    kind: "upsert",
    ids,
    lock: LockStatement(plan, rows),
    write: (existing) => {
      const missing = rows.filter((row) => !existing.has(row.id));
      const updates = rows
        .filter((row) => existing.has(row.id))
        .map((row) => UpdateStatement(plan, row, mode));
      return missing.length === 0
        ? updates
        : [...updates, InsertStatement(plan, missing)];
    },
  };
};
