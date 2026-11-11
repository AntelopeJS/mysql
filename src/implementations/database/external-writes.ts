import assert from "node:assert";
import type { QueryStage } from "@antelopejs/interface-database/common";

import type { PoolConnection } from "mysql2/promise";

import type { Dialect } from "../../dialect";
import { Read, Write } from "../../connection";
import { type Sql, ident, join, sql } from "../../statement";
import type { DecodingContext } from "./context";
import { FIRST_OPERAND } from "./stage";
import { OUTPUT_COLUMN, SetProjection } from "./relation";
import { Render } from "./render";
import { ID_COLUMN } from "./utils";
import { QualifiedColumn } from "./sql";
import type { ColumnDescriptor } from "./external-types";
import {
  type AssertedKey,
  type ExternalAssignment,
  type ExternalPayload,
  type ExternalWriteMode,
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
  Validate,
  WriteColumn,
  Written,
} from "./external-write-shared";
import { ExternalInsert } from "./external-insert";
import { ExternalWriteFailure } from "./external-errors";
import { InTransaction } from "./transaction";
import { WRITE_ALIAS, type WriteTarget } from "./writes-shared";
import { ClassifyMember, type DocumentView, StageOperand } from "./member";

const SOURCE_ALIAS = "src";
const AND = sql` AND `;
const COMMA = sql`, `;

type ExternalWriteCompiler = (
  target: WriteTarget,
  stage: QueryStage,
  context: DecodingContext,
) => ExternalWrite;

/** The precision a read answers a column at, which is what "unchanged since it was read" means. */
function AsRead(dialect: Dialect, value: Sql, descriptor: ColumnDescriptor) {
  return dialect.external.types.asRead(descriptor.kind, value);
}

/**
 * One guarded assignment: the column keeps its stored value when the incoming value equals what a
 * read of it answers, so a whole row written back damages nothing a lossy reading could not spell.
 */
function GuardedAssignment(
  dialect: Dialect,
  assignment: ExternalAssignment,
): Sql {
  const descriptor = assignment.descriptor;
  const column = WriteColumn(descriptor.column);
  if (assignment.toDefault) {
    return sql`${column} = DEFAULT`;
  }
  const read = AsRead(dialect, descriptor.value(column), descriptor);
  const incoming = AsRead(dialect, assignment.value.sql, descriptor);
  const same = dialect.sql.rows.nullSafeEqual(read, incoming);
  return sql`${column} = (CASE WHEN ${same} THEN ${column} ELSE ${Written(descriptor, assignment.value)} END)`;
}

/** Rows whose read differs from the incoming values: an unchanged write touches no row, and counts 0. */
function Changed(dialect: Dialect, assignments: ExternalAssignment[]): Sql[] {
  if (assignments.length === 0) {
    return [];
  }
  const same = assignments.map((assignment) => {
    const descriptor = assignment.descriptor;
    const read = descriptor.value(WriteColumn(descriptor.column));
    return dialect.sql.rows.nullSafeEqual(
      AsRead(dialect, read, descriptor),
      AsRead(dialect, assignment.value.sql, descriptor),
    );
  });
  return [sql`(NOT (${join(same, AND)}))`];
}

/**
 * A key field's claim, at the precision a read of it answers, so the value a whole-row edit read
 * back names the row it was read from, however lossy the field's kind.
 */
function KeyFieldAssertion(
  claim: ExternalPayload["keyFields"][number],
  context: DecodingContext,
): Sql {
  const dialect = context.dialect;
  const descriptor = claim.descriptor;
  const read = descriptor.value(WriteColumn(descriptor.column));
  const incoming = KeyFieldValue(claim, context).sql;
  return sql`(${AsRead(dialect, read, descriptor)} = ${AsRead(dialect, incoming, descriptor)})`;
}

/** A key column the payload claims through `_id`, as the row must already hold it. */
function Assertion(asserted: AssertedKey, context: DecodingContext): Sql {
  const value = KeyValue(asserted, context).sql;
  const convert = asserted.descriptor.conversion;
  return sql`(${WriteColumn(asserted.descriptor.column)} = ${convert ? convert(value, "=") : value})`;
}

/** A wide key joined part by part off the `_id` the read projected, or by `_id` itself. */
function JoinedKey(
  dialect: Dialect,
  key: ColumnDescriptor[],
  id: Sql,
  native: boolean,
): Sql {
  if (!native) {
    return sql`${IdOfWrittenRow(dialect, key)} = ${id}`;
  }
  const parts = dialect.external.types.idParts(id, key.length);
  const matches = key.map((part, position) => {
    const value = part.conversion
      ? part.conversion(parts[position], "=")
      : parts[position];
    return sql`${WriteColumn(part.column)} = ${value}`;
  });
  return join(matches, AND);
}

/** The rows a write changes, as the statement joins them: the hint and the `FROM` it follows. */
interface TargetedJoin {
  readonly hint: Sql;
  readonly from: Sql;
}

/**
 * The rows the read pipeline selected, joined by their key as a derived table the server
 * materializes first. The read projects the bare key column where it can, so the client's key
 * index serves the join; a wide key is joined part by part off its `_id`, and a read past a wrap
 * that hid the columns compares `_id` itself.
 */
function TargetedRows(
  target: WriteTarget,
  key: ColumnDescriptor[],
  context: DecodingContext,
): TargetedJoin {
  const dialect = context.dialect;
  const id = target.relation.source.field(ID_COLUMN);
  const native = id.native;
  const single = key.length === 1 && native !== undefined;
  const projected = SetProjection(
    target.relation,
    single ? { ...id, sql: native.sql } : id,
  );
  const value = QualifiedColumn(SOURCE_ALIAS, OUTPUT_COLUMN);
  const derived = sql`(${Render(projected)}) AS ${ident(SOURCE_ALIAS)}`;
  const on = single
    ? sql`${WriteColumn(key[0].column)} = ${value}`
    : JoinedKey(dialect, key, value, native !== undefined);
  return {
    hint: dialect.sql.rows.materialize(SOURCE_ALIAS),
    from: sql`${AliasedTable(ExternalOf(target))} JOIN ${derived} ON ${on}`,
  };
}

function DocumentOf(stage: QueryStage): DocumentView {
  const { document, kind } = ClassifyMember(StageOperand(stage, FIRST_OPERAND));
  assert(
    document,
    `The '${stage.stage}' stage on an external relation takes a document, received ${kind}; an expression mapper is not supported on external relations in this version`,
  );
  return document;
}

function ChangeStatement(
  target: WriteTarget,
  payload: ExternalPayload,
  context: DecodingContext,
): ExternalWrite {
  const key = RequireKey(target);
  const assignments = payload.assignments;
  if (assignments.length === 0) {
    return { kind: "count" };
  }
  const dialect = context.dialect;
  const conditions = [
    ...[...payload.asserted.values()].map((asserted) =>
      Assertion(asserted, context),
    ),
    ...payload.keyFields.map((claim) => KeyFieldAssertion(claim, context)),
    ...Changed(
      dialect,
      assignments.filter((assignment) => !assignment.toDefault),
    ),
  ];
  const rows = TargetedRows(target, key, context);
  const sets = join(
    assignments.map((assignment) => GuardedAssignment(dialect, assignment)),
    COMMA,
  );
  const where =
    conditions.length === 0 ? sql`` : sql` WHERE ${join(conditions, AND)}`;
  return {
    kind: "count",
    statement: sql`UPDATE ${rows.hint} ${rows.from} SET ${sets}${where}`,
  };
}

function ChangeWrite(mode: ExternalWriteMode): ExternalWriteCompiler {
  return (target, stage, context) => {
    RequireKey(target);
    const payload = SplitExternalPayload(
      DocumentOf(stage),
      target.origin.model,
      context,
      mode,
    );
    Validate(ExternalOf(target), payload, mode);
    return ChangeStatement(target, payload, context);
  };
}

const ExternalDelete: ExternalWriteCompiler = (target, _stage, context) => {
  const rows = TargetedRows(target, RequireKey(target), context);
  return {
    kind: "count",
    statement: sql`DELETE ${rows.hint} ${ident(WRITE_ALIAS)} FROM ${rows.from}`,
  };
};

/** The writes of an external relation, by stage. */
const EXTERNAL_WRITES = new Map<string, ExternalWriteCompiler>([
  ["insert", ExternalInsert],
  ["update", ChangeWrite("update")],
  ["replace", ChangeWrite("replace")],
  ["delete", ExternalDelete],
]);

/** Compiles a terminal write to an external relation; `atomicMutation` is refused before this. */
function CompileExternalWrite(
  target: WriteTarget,
  stage: QueryStage,
  context: DecodingContext,
): ExternalWrite {
  const compile = EXTERNAL_WRITES.get(stage.stage);
  assert(compile, `Unsupported write stage '${stage.stage}'`);
  return compile(target, stage, context);
}

/** One document of an insert, or of an upsert that found its row; answers the row's `_id`. */
async function InsertOne(
  row: ExternalInsertRow,
  connection: PoolConnection,
): Promise<string> {
  const upsert = row.upsert;
  const found =
    upsert !== undefined && (await Read(upsert.lock, connection)).length > 0;
  if (!found) {
    await Write(row.insert, connection);
  } else if (upsert.update) {
    await Write(upsert.update, connection);
  }
  const [written] = await Read(row.readId, connection);
  return String(written?.get(ID_COLUMN));
}

async function Execute(write: ExternalWrite): Promise<string[] | number> {
  if (write.kind === "count") {
    return write.statement ? Write(write.statement) : 0;
  }
  if (write.rows.length === 0) {
    return [];
  }
  return InTransaction(async (connection) => {
    const ids: string[] = [];
    for (const row of write.rows) {
      ids.push(await InsertOne(row, connection));
    }
    return ids;
  });
}

/**
 * Runs a terminal write to an external relation: its constants checked before anything runs, an
 * insert's keys read back in input order, a write that changes nothing answered 0, and a refusal
 * the server reports read as what it means rather than as an errno.
 */
export async function RunExternalWrite(
  target: WriteTarget,
  stage: QueryStage,
  context: DecodingContext,
): Promise<string[] | number> {
  const write = CompileExternalWrite(target, stage, context);
  try {
    return await Execute(write);
  } catch (err) {
    throw err instanceof Error
      ? ExternalWriteFailure(context.dialect, err, ExternalOf(target))
      : err;
  }
}
