import assert from "node:assert";
import type { QueryStage } from "@antelopejs/interface-database/common";

import type { Dialect } from "../../dialect";
import { type Sql, ident, join, sql } from "../../statement";
import { AsJson } from "./readings";
import { FIRST_OPERAND } from "./stage";
import { JsonRowSource } from "./row-source";
import { JsonOf, type KeyTypes } from "./types";
import type { DecodingContext } from "./context";
import { Render } from "./render";
import { EXTRA_COLUMN, ID_COLUMN, INSTANCE_COLUMN } from "./utils";
import { type Compiled, QualifiedColumn } from "./sql";
import { DeclaredColumns, DocumentKeys, type TableModel } from "./fields";
import {
  DecodeValue,
  FUNCTION_BODY,
  IsRecordedFunction,
  type RecordedFunction,
  WithBoundArguments,
} from "./value";
import {
  ID_AS_ASSERTION,
  MembersByColumn,
  NULL_VALUE,
  type PayloadOptions,
  type PayloadSplit,
  SplitPayload,
} from "./payload";
import {
  Assignment,
  ExistingExtra,
  MergeExtra,
  RequireInstance,
  WRITE_ALIAS,
  type WriteCompiler,
  WriteRowSource,
  type WriteStatement,
  WriteTable,
  type WriteTarget,
} from "./writes-shared";
import { ClassifyMember, type DocumentView, StageOperand } from "./member";

/** Neither `update` nor `replace` is keyed by its payload: an `_id` it names states a target. */
const CHANGED: PayloadOptions = { id: ID_AS_ASSERTION };

const COMMA = sql`, `;
const OR = sql` OR `;

/** The identity columns a row is joined to the read by, in the order the primary key declares them. */
const IDENTITY = [INSTANCE_COLUMN, ID_COLUMN];

/** The read a write targets, joined by identity as a derived table the server materializes first. */
interface Targeted {
  readonly alias: string;
  readonly hint: Sql;
  readonly from: Sql;
}

/**
 * Joins the targeted table to the rows the read pipeline found, by identity.
 *
 * A subquery over the table being written is refused by the server unless the read is
 * materialized first, so the derived table carries the dialect's hint to keep it from being
 * merged. Being materialized also means it holds every row as it was before the statement, which
 * is what the values a write computes read.
 */
function TargetedRows(target: WriteTarget, alias: string): Targeted {
  const on = IDENTITY.map(
    (column) =>
      sql`${QualifiedColumn(WRITE_ALIAS, column)} = ${QualifiedColumn(alias, column)}`,
  );
  return {
    alias,
    hint: target.relation.dialect.sql.rows.materialize(alias),
    from: sql`${WriteTable(target.origin)} JOIN (${Render(target.relation)}) AS ${ident(alias)} ON ${join(on, sql` AND `)}`,
  };
}

/** One column a write assigns, beside the value it assigns to it. */
interface WrittenColumn {
  column: string;
  value: Sql;
}

/**
 * One payload's assignments, and the predicates they imply: the row identity the payload asserted
 * if it named one, and `modified` — absent for the one assignment stating no column-by-column
 * values.
 */
interface ChangedColumns {
  assignments: WrittenColumn[];
  modified?: Sql;
  identity?: Compiled;
}

/**
 * The rows this write would actually change, which is the count the contract says it answers: a
 * null-safe inequality per column, since a NULL on either side is an ordinary value here.
 */
function ModifiedRows(dialect: Dialect, written: WrittenColumn[]): Sql {
  const tests = written.map(
    (one) =>
      sql`NOT ${dialect.sql.rows.nullSafeEqual(QualifiedColumn(WRITE_ALIAS, one.column), one.value)}`,
  );
  return sql`(${join(tests, OR)})`;
}

function ChangedFrom(
  dialect: Dialect,
  written: WrittenColumn[],
  identity: Compiled | undefined,
): ChangedColumns {
  return {
    assignments: written,
    modified: ModifiedRows(dialect, written),
    identity,
  };
}

/** Refuses a payload that asserts a key over a selection the write did not address by one. */
function RequireAddressedRow(
  target: WriteTarget,
  stage: QueryStage,
  identity: Compiled | undefined,
): void {
  assert(
    target.relation.single || !identity,
    `The '${stage.stage}' stage was given a payload naming '${ID_COLUMN}' over a selection of many rows: address the row with get(${ID_COLUMN}) first, or leave '${ID_COLUMN}' out of the payload`,
  );
}

/**
 * The statement `update` and `replace` compile to, given the columns each built for itself. An
 * asserted `_id` narrows the rows rather than renaming one, so a foreign key answers 0.
 */
function UpdateStatement(
  target: WriteTarget,
  stage: QueryStage,
  changed: ChangedColumns,
  rows: Targeted,
): WriteStatement {
  RequireAddressedRow(target, stage, changed.identity);
  const predicates: Sql[] = [];
  if (changed.identity) {
    const key = QualifiedColumn(WRITE_ALIAS, ID_COLUMN);
    predicates.push(sql`(${key} = ${changed.identity.sql})`);
  }
  if (changed.modified) {
    predicates.push(changed.modified);
  }
  const set = join(
    changed.assignments.map((one) => Assignment(one.column, one.value)),
    COMMA,
  );
  const where =
    predicates.length === 0
      ? sql``
      : sql` WHERE ${join(predicates, sql` AND `)}`;
  return {
    kind: "count",
    statement: sql`UPDATE ${rows.hint} ${rows.from} SET ${set}${where}`,
  };
}

function ChangedDocument(stage: QueryStage): DocumentView {
  const { document, kind } = ClassifyMember(StageOperand(stage, FIRST_OPERAND));
  assert(
    document,
    `The '${stage.stage}' stage takes a document, received ${kind}`,
  );
  return document;
}

function ChangedPayload(
  document: DocumentView,
  target: WriteTarget,
  context: DecodingContext,
): PayloadSplit {
  return SplitPayload(document, target.origin.model, context, CHANGED);
}

/** What the overflow column becomes: the row's own with the written keys set and the removed ones gone. */
function UpdatedExtra(dialect: Dialect, split: PayloadSplit): Sql | undefined {
  if (!split.extra && split.removed.length === 0) {
    return undefined;
  }
  const merged = split.extra
    ? MergeExtra(dialect, split.extra)
    : ExistingExtra(dialect);
  return dialect.sql.json.removeKeys(merged, split.removed);
}

/**
 * The assignments one `update` payload makes, and the refusal of a payload that makes none: an
 * empty `SET` list is a syntax error, so an empty payload — `_id` alone included — is refused.
 */
function UpdatedColumns(
  dialect: Dialect,
  split: PayloadSplit,
  stage: QueryStage,
): WrittenColumn[] {
  const written = split.members.map((member) => ({
    column: member.column,
    value: member.value.sql,
  }));
  for (const column of split.cleared) {
    written.push({ column, value: NULL_VALUE });
  }
  const extra = UpdatedExtra(dialect, split);
  if (extra) {
    written.push({ column: EXTRA_COLUMN, value: extra });
  }
  assert(
    written.length > 0,
    `The '${stage.stage}' stage was given a payload with nothing to write: name a field to set, or set one to undefined to remove it`,
  );
  return written;
}

function ChangedColumnsOf(
  dialect: Dialect,
  split: PayloadSplit,
  stage: QueryStage,
): ChangedColumns {
  return ChangedFrom(
    dialect,
    UpdatedColumns(dialect, split, stage),
    split.identity,
  );
}

/**
 * The assignments one `replace` payload makes, which are every column the table has: a column the
 * payload is silent about is set to NULL, and the overflow document is assigned outright.
 */
function ReplacedColumns(
  dialect: Dialect,
  split: PayloadSplit,
  model: TableModel,
): WrittenColumn[] {
  const supplied = MembersByColumn(split);
  const written = DeclaredColumns(model).map((column) => ({
    column,
    value: supplied.get(column)?.sql ?? NULL_VALUE,
  }));
  written.push({
    column: EXTRA_COLUMN,
    value: split.extra?.document.sql ?? dialect.sql.json.emptyObject,
  });
  return written;
}

/** The types a mapper's document carries, keyed the way the document is: by field name. */
function MappedKeyTypes(model: TableModel): KeyTypes {
  return Object.fromEntries(
    Object.entries(model.fields).map(([name, spec]) => [name, spec.type]),
  );
}

/**
 * Assigns every column from a mapper's document whose keys are not statically known: each declared
 * column reads its own member, and the overflow column is the document without them, guarded on
 * the document being an object and defaulted to an empty one, since the column is `NOT NULL`.
 */
function MultiAssignment(
  dialect: Dialect,
  model: TableModel,
  document: Compiled,
): WrittenColumn[] {
  const json = dialect.sql.json;
  const mapped: Compiled = {
    sql: document.sql,
    type: JsonOf(MappedKeyTypes(model)),
  };
  const source = new JsonRowSource(dialect, mapped);
  const declared = Object.entries(model.fields).map(([name, spec]) => ({
    column: spec.column,
    value: source.field(name).sql,
  }));
  const kept = json.removeKeys(document.sql, DocumentKeys(model));
  const extra = sql`COALESCE(CASE WHEN ${json.is(document.sql, ["object"])} THEN ${kept} END, ${json.emptyObject})`;
  return [...declared, { column: EXTRA_COLUMN, value: extra }];
}

/**
 * The assignments a mapper makes: an object body is the payload path, anything else assigns every
 * column. Only the object body can assert an identity, and only the expression body answers rows
 * *matched* rather than changed.
 */
function MappedColumns(
  target: WriteTarget,
  stage: QueryStage,
  mapper: RecordedFunction,
  context: DecodingContext,
  rows: Targeted,
): ChangedColumns {
  const dialect = context.dialect;
  const body = ClassifyMember(mapper.args[FUNCTION_BODY]);
  const bindings = [WriteRowSource(dialect, target.origin, rows.alias)];
  if (body.kind === "record") {
    const split = WithBoundArguments(mapper, context, bindings, () =>
      ChangedPayload(body.document, target, context),
    );
    return ChangedColumnsOf(dialect, split, stage);
  }
  const document = WithBoundArguments(mapper, context, bindings, () =>
    DecodeValue(body, context),
  );
  assert(
    document,
    `The '${stage.stage}' stage was given a mapper that returned nothing: return the document the rows become`,
  );
  return {
    assignments: MultiAssignment(
      dialect,
      target.origin.model,
      AsJson(dialect, document),
    ),
  };
}

/**
 * Changes the rows the read pipeline selected, one column per key the payload named. Allowed under
 * `CROSS_INSTANCE`, since `_instance` is never assigned and each row keeps its own instance.
 */
export const UpdateWrite: WriteCompiler = (target, stage, context) => {
  const rows = TargetedRows(target, context.nextAlias());
  const argument = StageOperand(stage, FIRST_OPERAND);
  const changed = IsRecordedFunction(argument)
    ? MappedColumns(target, stage, argument, context, rows)
    : ChangedColumnsOf(
        context.dialect,
        ChangedPayload(ChangedDocument(stage), target, context),
        stage,
      );
  return UpdateStatement(target, stage, changed, rows);
};

/**
 * States the rows the read pipeline selected in full: every declared column and the overflow one.
 * Refused under `CROSS_INSTANCE` by name, unlike `update`, which changes only the columns named.
 */
export const ReplaceWrite: WriteCompiler = (target, stage, context) => {
  RequireInstance(target, stage);
  const rows = TargetedRows(target, context.nextAlias());
  const split = ChangedPayload(ChangedDocument(stage), target, context);
  const changed = ChangedFrom(
    context.dialect,
    ReplacedColumns(context.dialect, split, target.origin.model),
    split.identity,
  );
  return UpdateStatement(target, stage, changed, rows);
};

/**
 * Removes the rows the read pipeline selected, ordering and row bounds included. Allowed under
 * `CROSS_INSTANCE`: a delete writes no column, so the rows it found are the rows it removes.
 */
export const DeleteWrite: WriteCompiler = (target, _stage, context) => {
  const rows = TargetedRows(target, context.nextAlias());
  return {
    kind: "count",
    statement: sql`DELETE ${rows.hint} ${ident(WRITE_ALIAS)} FROM ${rows.from}`,
  };
};
