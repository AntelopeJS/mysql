import type { QueryStage } from "@antelopejs/interface-database/common";
import type { AtomicMutationOutcome } from "@antelopejs/interface-database";
import { ValidateAtomicMutationTable } from "@antelopejs/interface-database/atomic";

import { IsExternal } from "../../config";
import { GetDialect, Read, type Row, Write } from "../../connection";
import { DecodingContext } from "./context";
import { CompileSubquery } from "./subquery";
import { CompileExpression } from "./expression";
import { DecodeCell, DecodeRow, type RowValue } from "./result";
import { ApplyStages, CHANGES_STAGE, CompileRelation } from "./pipeline";
import { DuplicateKeyFailure, IsPrimaryKeyDuplicate } from "./duplicate-key";
import {
  GetTableNames,
  WaitForSchemaReady,
  WaitForUniqueIndexes,
} from "./schema";
import { CreateInstance, DestroyInstance, ListInstances } from "./instances";
import {
  type WriteStatement,
  type WriteTarget,
  WriteTargetOf,
} from "./writes-shared";
import { CompileWrite, SplitWrite, type WriteSplit } from "./writes";
import { ATOMIC_MUTATION, ExecuteAtomicWrite } from "./writes-atomic";
import { InTransaction } from "./transaction";
import { ID_COLUMN, OptionsOf } from "./utils";
import { CloseOneCursor, type CursorRequest, ReadCursorRow } from "./cursors";
import { CloseOneFeed, ReadFeedEvent } from "./feeds";
import { NudgeChanges } from "./change-loop";
import { OUTPUT_COLUMN, type Relation, RequireOrigin } from "./relation";
import { Render } from "./render";
import {
  BuildRoot,
  CollectSchemaIds,
  type RootSelection,
  SCHEMA_STAGE,
} from "./selection";
import { IsString } from "./guards";
import {
  ExternalFeedRefusal,
  ExternalInstanceRefusal,
  ExternalWriteRefusal,
} from "./external-refusals";
import { RunExternalWrite } from "./external-writes";

type WriteAnswer = string[] | number | AtomicMutationOutcome;

/** The root, the terminal write split off after it, and the fold over what was left. */
interface CompiledQuery {
  context: DecodingContext;
  root: RootSelection;
  split: WriteSplit;
  relation: Relation;
}

type LifecycleAnswer = string | string[] | void;

type LifecycleHandler = (
  schemaId: string,
  stage: QueryStage,
) => Promise<LifecycleAnswer>;

const LIFECYCLE_STAGE_COUNT = 2;

const MISSING_SCHEMA_ID = "Lifecycle query is missing its schema id";

/** The instance lifecycle stages, which address a schema rather than a table. */
const LIFECYCLE_HANDLERS = new Map<string, LifecycleHandler>([
  ["createInstance", CreateInstance],
  [
    "destroyInstance",
    (schemaId, stage) =>
      DestroyInstance(schemaId, GetTableNames(schemaId), stage),
  ],
  ["listInstances", ListInstances],
]);

/**
 * An external instance's relations have no instances: creating or destroying one is refused, and
 * the list of them is empty.
 */
const EXTERNAL_LIFECYCLE = new Map<string, LifecycleHandler>([
  [
    "createInstance",
    (_schemaId, stage) => Promise.reject(ExternalInstanceRefusal(stage.stage)),
  ],
  [
    "destroyInstance",
    (_schemaId, stage) => Promise.reject(ExternalInstanceRefusal(stage.stage)),
  ],
  ["listInstances", () => Promise.resolve([])],
]);

/** Dispatches a schema-rooted instance lifecycle query, after the schema's readiness gate. */
function Lifecycle(stages: QueryStage[]): Promise<LifecycleAnswer> | undefined {
  if (
    stages.length !== LIFECYCLE_STAGE_COUNT ||
    stages[0].stage !== SCHEMA_STAGE
  ) {
    return undefined;
  }
  const stage = stages[1];
  const handler = (IsExternal() ? EXTERNAL_LIFECYCLE : LIFECYCLE_HANDLERS).get(
    stage.stage,
  );
  if (!handler) {
    return undefined;
  }
  const schemaId: unknown = OptionsOf(stages[0])?.id;
  if (!IsString(schemaId)) {
    return Promise.reject(new Error(MISSING_SCHEMA_ID));
  }
  return WaitForSchemaReady(schemaId).then(() => handler(schemaId, stage));
}

/**
 * Decodes every row the driver returned, in order and one value per row, on the same `projection`
 * the select list was built from. A cursor decodes through this and never through
 * {@link DecodeResult}, which applies the relation's single-row answers.
 */
export function DecodeRows(relation: Relation, rows: Row[]): RowValue[] {
  const projection = relation.projection;
  if (projection) {
    return rows.map((row) =>
      DecodeCell(row.get(OUTPUT_COLUMN), projection.type),
    );
  }
  const model = RequireOrigin(relation).model;
  return rows.map((row) => DecodeRow(row, model));
}

/**
 * Turns the driver's rows into what the caller asked for: a single-row relation hands back that row,
 * or the absent value it carries when it read none, decided by the row count rather than by the
 * decoded value, so a `get` whose row decodes to `null` answers `null`.
 */
export function DecodeResult(relation: Relation, rows: Row[]): RowValue {
  const decoded = DecodeRows(relation, rows);
  if (!relation.single) {
    return decoded;
  }
  return decoded.length > 0 ? decoded[0] : relation.absent;
}

/** The keys of an upsert's batch that its lock read found. */
function LockedIds(rows: Row[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    const id = row.get(ID_COLUMN);
    if (IsString(id)) {
      ids.add(id);
    }
  }
  return ids;
}

/** Runs a compiled write and answers what its stage promised. */
async function Execute(
  statement: WriteStatement,
  target: WriteTarget,
): Promise<WriteAnswer> {
  const dialect = target.relation.dialect;
  switch (statement.kind) {
    case "count":
      return InTransaction((connection) =>
        Write(statement.statement, connection),
      );
    case "atomic":
      return ExecuteAtomicWrite(dialect, () => Write(statement.statement));
    case "insert": {
      const statements = statement.statements;
      if (statements.length === 1) {
        await Write(statements[0]);
      } else if (statements.length > 1) {
        await InTransaction(async (connection) => {
          for (const one of statements) {
            await Write(one, connection);
          }
        });
      }
      return statement.ids;
    }
    case "upsert":
      await InTransaction(
        async (connection) => {
          const existing = LockedIds(await Read(statement.lock, connection));
          for (const one of statement.write(existing)) {
            await Write(one, connection);
          }
        },
        (err) => IsPrimaryKeyDuplicate(err, target.origin, dialect),
      );
      return statement.ids;
  }
}

/**
 * Executes a terminal write and answers what its stage promised: `insert` its keys in input order,
 * an atomic mutation its outcome, everything else the rows it matched. A failure the server reports
 * against a unique key is answered as the interface's error for it.
 */
async function RunWrite(
  target: WriteTarget,
  stage: QueryStage,
  context: DecodingContext,
): Promise<WriteAnswer> {
  if (target.origin.model.external) {
    return RunExternalWrite(target, stage, context);
  }
  const statement = CompileWrite(target, stage, context);
  await WaitForUniqueIndexes(target.origin.schemaId);
  try {
    const answer = await Execute(statement, target);
    NudgeChanges();
    return answer;
  } catch (err) {
    throw err instanceof Error
      ? DuplicateKeyFailure(err, target.origin, context.dialect)
      : err;
  }
}

/** The one production construction of a compiling context, fresh per statement. */
function QueryContext(): DecodingContext {
  return new DecodingContext(
    {
      expression: CompileExpression,
      subquery: CompileSubquery,
      relation: CompileRelation,
    },
    GetDialect(),
  );
}

/** Root, split, fold — kept apart, and `root` kept visible, because the split runs between them. */
function CompileQuery(
  stages: QueryStage[],
  context: DecodingContext,
): CompiledQuery {
  if (stages.at(-1)?.stage === ATOMIC_MUTATION) {
    ValidateAtomicMutationTable(stages.slice(0, -1));
  }
  const root = BuildRoot(stages, context);
  const split = SplitWrite(root.rest);
  const relation = ApplyStages(
    TargetRead(root, split),
    split.pipeline,
    context,
  );
  return { context, root, split, relation };
}

/**
 * The table read a query starts from. An owned table's write locks each row exclusively as its read
 * reaches it, in the block that reads the table however deep a stage nests that block: a read
 * nested in a write statement otherwise takes shared locks, and two writers that each hold one and
 * wait to upgrade it deadlock however often they run again.
 */
function TargetRead(root: RootSelection, split: WriteSplit): Relation {
  const owned = !RequireOrigin(root.relation).model.external;
  return split.write !== undefined && owned
    ? { ...root.relation, locked: true }
    : root.relation;
}

/** Awaits every schema the stage tree reads, then compiles it in one synchronous pass. */
async function ReadyQuery(
  stages: QueryStage[],
  context: DecodingContext,
): Promise<CompiledQuery> {
  await Promise.all(CollectSchemaIds(stages).map(WaitForSchemaReady));
  return CompileQuery(stages, context);
}

export async function RunQuery(
  stages: QueryStage[],
): Promise<RowValue | LifecycleAnswer> {
  const lifecycle = Lifecycle(stages);
  if (lifecycle) {
    return lifecycle;
  }
  const compiled = await ReadyQuery(stages, QueryContext());
  if (!compiled.split.write) {
    const rows = await Read(Render(compiled.relation));
    return DecodeResult(compiled.relation, rows);
  }
  const external = compiled.root.external;
  if (external && compiled.split.write.stage === ATOMIC_MUTATION) {
    throw ExternalWriteRefusal(external, compiled.split.write.stage);
  }
  return RunWrite(
    WriteTargetOf(compiled.root, compiled.relation),
    compiled.split.write,
    compiled.context,
  );
}

function RefuseCursorWrite(write: QueryStage): never {
  throw new Error(
    `The '${write.stage}' stage writes, so it cannot be read through a cursor`,
  );
}

/**
 * Compiles the relation a cursor reads, or refuses a query that has none: a terminal write is
 * refused by name rather than executed, so iterating a write never runs it.
 */
async function CompileCursor(stages: QueryStage[]): Promise<CursorRequest> {
  const compiled = await ReadyQuery(stages, QueryContext());
  if (compiled.split.write) {
    RefuseCursorWrite(compiled.split.write);
  }
  const relation = compiled.relation;
  return {
    statement: Render(relation),
    decode: (rows) => DecodeRows(relation, rows),
  };
}

/** A query is a feed exactly when it ends in `changes`. */
function IsFeed(stages: QueryStage[]): boolean {
  return stages.at(-1)?.stage === CHANGES_STAGE;
}

/** Refuses a change feed on an external relation by name, since nothing is installed on it. */
async function RefuseExternalFeed(stages: QueryStage[]): Promise<void> {
  await Promise.all(CollectSchemaIds(stages).map(WaitForSchemaReady));
  const external = BuildRoot(stages, QueryContext()).external;
  if (external) {
    throw ExternalFeedRefusal(external);
  }
}

/** Answers one element of the cursor `reqId` names, or one event of the change feed it names. */
export function ReadCursor(
  reqId: number,
  stages: QueryStage[],
): Promise<IteratorResult<RowValue, void>> {
  if (IsFeed(stages)) {
    return IsExternal()
      ? RefuseExternalFeed(stages).then(() => ReadFeedEvent(reqId, stages))
      : ReadFeedEvent(reqId, stages);
  }
  return ReadCursorRow(reqId, () => CompileCursor(stages));
}

/**
 * Closes the cursor or the feed `reqId` names; total for an id that never opened, so a feed's read
 * arriving after its close answers `done`.
 */
export async function CloseCursor(reqId: number): Promise<void> {
  await CloseOneFeed(reqId);
  await CloseOneCursor(reqId);
}
