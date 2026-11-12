import assert from "node:assert";
import type { QueryStage } from "@antelopejs/interface-database/common";
import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";

import { type Sql, ident, sql } from "../../statement";
import { IndexFields } from "./plan";
import { ClassifyMember, type Member, StageOperand } from "./member";
import type { DecodingContext } from "./context";
import { type Compiled, QualifiedColumn, TextParam } from "./sql";
import { type Relation, type TableOrigin, TableRelation } from "./relation";
import {
  GetCrossInstanceScanNotice,
  GetIndex,
  GetTableModel,
  GetTablePlan,
} from "./schema";
import { DEFAULT_INSTANCE_ID, INSTANCE_COLUMN, OptionsOf } from "./utils";
import { IsString } from "./guards";
import type { ExternalRelation } from "./fields";
import { RelationName } from "./external-refusals";

export const SCHEMA_STAGE = "schema";
const INSTANCE_STAGE = "instance";
const TABLE_STAGE = "table";

const ROOT_STAGES: readonly string[] = [
  SCHEMA_STAGE,
  INSTANCE_STAGE,
  TABLE_STAGE,
];

/**
 * How a query is scoped to an instance: the fragment its predicate bound, or every instance at once.
 *
 * A relation records only the *absence* of an instance predicate, so it cannot tell a
 * cross-instance query from a table nobody filtered; this is what the writes read instead.
 */
export type InstanceScope = typeof CROSS_INSTANCE | Compiled;

/** The base relation of a table query, the stages still to fold over it, and the instance it reads. */
export interface RootSelection {
  relation: Relation;
  rest: QueryStage[];
  instance: InstanceScope;
  /** The relation a query reads when the adapter did not create it. */
  external?: ExternalRelation;
}

/**
 * Answers what a relation needs to know about a table it has not read yet. Injected on the
 * context so a spec can compile against a stubbed registry; production reads the live one.
 */
export type OriginResolver = (schemaId: string, tableId: string) => TableOrigin;

export function RegisteredOrigin(
  schemaId: string,
  tableId: string,
): TableOrigin {
  return {
    schemaId,
    tableId,
    model: GetTableModel(schemaId, tableId),
    plan: GetTablePlan(schemaId, tableId),
    index: (name) => IndexFields(name, GetIndex(schemaId, tableId, name)),
    crossInstanceScan: GetCrossInstanceScanNotice(schemaId, tableId),
  };
}

function RootStage(
  stages: QueryStage[],
  expected: string,
  index: number,
): QueryStage {
  const found = stages[index]?.stage;
  assert(
    found === expected,
    `A table query must open with ${ROOT_STAGES.join(", ")}; stage ${index} is '${found ?? "missing"}'`,
  );
  return stages[index];
}

function RootId(stage: QueryStage): string {
  const id: unknown = OptionsOf(stage)?.id;
  assert(
    IsString(id),
    `The '${stage.stage}' stage of a table query is missing its id`,
  );
  return id;
}

/** The kind of an option value a caller passed instead of a string, for a refusal's message. */
function ReceivedKind(stage: QueryStage): Member["kind"] {
  const id = OptionsOf(stage)?.id;
  return ClassifyMember(id === CROSS_INSTANCE ? undefined : id).kind;
}

/**
 * The instance a query reads, bound once for the predicate and for any write that follows.
 * An absent id is the empty string; `CROSS_INSTANCE` binds nothing and contributes no predicate.
 */
function RootInstanceScope(
  instance: QueryStage,
  context: DecodingContext,
): InstanceScope {
  const id: unknown = OptionsOf(instance)?.id;
  if (id === CROSS_INSTANCE) {
    return CROSS_INSTANCE;
  }
  assert(
    id === undefined || id === null || IsString(id),
    `An instance id must be a string or CROSS_INSTANCE, received ${ReceivedKind(instance)}`,
  );
  return TextParam(context.dialect, id ?? DEFAULT_INSTANCE_ID);
}

/** Restricts the relation to one instance, parenthesised as every `where` entry is. */
function InstancePredicate(alias: string, value: Compiled): Sql {
  return sql`(${QualifiedColumn(alias, INSTANCE_COLUMN)} = ${value.sql})`;
}

/**
 * The scope of a read over a relation the adapter did not create, which has no instances: the
 * default instance and `CROSS_INSTANCE` both read every row, and a named instance is refused rather
 * than answered with rows nobody scoped to it.
 */
function RefuseNamedInstance(
  external: ExternalRelation,
  instance: QueryStage,
): void {
  const id: unknown = OptionsOf(instance)?.id;
  const unscoped: readonly unknown[] = [
    undefined,
    null,
    CROSS_INSTANCE,
    DEFAULT_INSTANCE_ID,
  ];
  if (!unscoped.includes(id)) {
    throw new Error(
      `${RelationName(external)} is an external relation and has no instances, so instance '${String(id)}' names nothing: read it through the default instance`,
    );
  }
}

/** An external relation's root: its own names, verbatim, and no instance to filter on. */
function ExternalRoot(
  origin: TableOrigin,
  external: ExternalRelation,
  instance: QueryStage,
  context: DecodingContext,
): Relation {
  RefuseNamedInstance(external, instance);
  const from = sql`${ident(external.schema)}.${ident(external.table)}`;
  return TableRelation(context.dialect, from, context.nextAlias(), origin);
}

/** Whether a table query reads its table whole: the root prefix, and no stage after it. */
export function IsTableRead(stages: readonly QueryStage[]): boolean {
  return stages.length === ROOT_STAGES.length;
}

/**
 * Consumes the `schema` / `instance` / `table` prefix every table query opens with, and returns
 * the base relation alongside the pipeline stages that follow it.
 */
export function BuildRoot(
  stages: QueryStage[],
  context: DecodingContext,
): RootSelection {
  const [schema, instance, table] = ROOT_STAGES.map((expected, index) =>
    RootStage(stages, expected, index),
  );
  const resolve = context.resolveOrigin ?? RegisteredOrigin;
  const origin = resolve(RootId(schema), RootId(table));
  const rest = stages.slice(ROOT_STAGES.length);
  const external = origin.model.external;
  if (external) {
    const relation = ExternalRoot(origin, external, instance, context);
    return { relation, rest, instance: CROSS_INSTANCE, external };
  }
  const alias = context.nextAlias();
  const relation = TableRelation(
    context.dialect,
    ident(origin.plan.table),
    alias,
    origin,
  );
  relation.table = origin;
  const scope = RootInstanceScope(instance, context);
  relation.crossInstance = scope === CROSS_INSTANCE;
  if (scope !== CROSS_INSTANCE) {
    relation.where.push(
      context.fragment(() => InstancePredicate(alias, scope)),
    );
  }
  return { relation, rest, instance: scope };
}

/** What one walk does with each stage, beside the objects already walked. */
interface StageWalk {
  visit: (stage: QueryStage) => void;
  visited: WeakSet<object>;
}

/**
 * Walks a stage argument, which is caller data and may be any shape a document may be.
 * Plain objects reach every recorded lambda body; the visited set is for a caller's cyclic object.
 */
function CollectValue(value: Member, walk: StageWalk): void {
  if (!("identity" in value) || walk.visited.has(value.identity)) {
    return;
  }
  walk.visited.add(value.identity);
  switch (value.kind) {
    case "proxy":
    case "query":
    case "staged":
      CollectInto(value.value.build(), walk);
      return;
    case "list":
      value.items().forEach((item) => CollectValue(item, walk));
      return;
    case "record":
      for (const [, item] of value.document.entries()) {
        CollectValue(item, walk);
      }
      return;
    default:
      return value satisfies never;
  }
}

function CollectInto(stages: QueryStage[], walk: StageWalk): void {
  for (const stage of stages) {
    walk.visit(stage);
    if (stage.stage === "atomicMutation") {
      continue;
    }
    stage.args.forEach((_, index) => {
      CollectValue(ClassifyMember(StageOperand(stage, index)), walk);
    });
  }
}

/**
 * Every schema the stage tree reads, including those rooted in a nested query.
 *
 * Compilation is synchronous and reads shapes that only exist once a registration has
 * converged, so the caller awaits all of these before compiling anything.
 */
export function CollectSchemaIds(stages: QueryStage[]): string[] {
  const ids = new Set<string>();
  WalkStages(stages, (stage) => {
    const id: unknown = OptionsOf(stage)?.id;
    if (stage.stage === SCHEMA_STAGE && IsString(id)) {
      ids.add(id);
    }
  });
  return [...ids];
}

/** Visits every stage of the tree, those of nested queries and recorded lambda bodies included. */
export function WalkStages(
  stages: QueryStage[],
  visit: (stage: QueryStage) => void,
): void {
  CollectInto(stages, { visit, visited: new WeakSet() });
}
