import type { QueryStage } from "@antelopejs/interface-database/common";

import { SplitWrite } from "./writes";
import { BuildRoot } from "./selection";
import type { Relation } from "./relation";
import { ROW_STAGES } from "./stages-rows";
import type { DecodingContext } from "./context";
import { AGGREGATE_STAGES } from "./stages-aggregate";
import { SELECTION_STAGES } from "./stages-selection";
import { PROJECTION_STAGES } from "./stages-projection";

/**
 * One step of the read pipeline: it either absorbs into the relation it is given or wraps it,
 * and every wrap decision goes through `Prepare`.
 */
export type PipelineStage = (
  relation: Relation,
  stage: QueryStage,
  context: DecodingContext,
) => Relation;

export type PipelineStageMap = Record<string, PipelineStage>;

/**
 * The merged stage vocabulary, spread once at module scope. No family module imports this one at
 * runtime — a stage that needs a nested query asks the context — so no family can be half-written
 * when the spread runs. A family is added as a module and spread here.
 */
const PIPELINE_STAGES = {
  ...ROW_STAGES,
  ...SELECTION_STAGES,
  ...PROJECTION_STAGES,
  ...AGGREGATE_STAGES,
} satisfies PipelineStageMap;

const RELATIONAL = "relational";
const AGGREGATE = "aggregate";

/** The pipeline stages whose family is not implemented yet, by the family that will own them. */
const DEFERRED_STAGES: ReadonlyMap<string, string> = new Map([
  ["join", RELATIONAL],
  ["lookup", RELATIONAL],
  ["group", RELATIONAL],
  ["sum", AGGREGATE],
  ["avg", AGGREGATE],
  ["min", AGGREGATE],
  ["max", AGGREGATE],
  ["distinct", AGGREGATE],
]);

/** The stage that opens a change feed, which only an iterated query's last stage may be. */
export const CHANGES_STAGE = "changes";

/**
 * Stages this backend refuses wherever they reach the fold. An iterated feed is dispatched before
 * any compilation, so a `changes` that arrives here is either not the last stage or is being
 * awaited, which asks for a finite answer to an unbounded question.
 */
const REJECTED_STAGES = new Map<string, string>([
  [
    CHANGES_STAGE,
    "A 'changes' feed must be the last stage of a query and must be iterated rather than awaited",
  ],
]);

function StageError(name: string): Error {
  const refusal = REJECTED_STAGES.get(name);
  if (refusal !== undefined) {
    return new Error(refusal);
  }
  const family = DEFERRED_STAGES.get(name);
  if (family !== undefined) {
    return new Error(
      `The '${name}' stage (${family} family) is not implemented by @antelopejs/mysql yet`,
    );
  }
  return new Error(`Unsupported query stage '${name}'`);
}

function ApplyStage(
  relation: Relation,
  stage: QueryStage,
  context: DecodingContext,
): Relation {
  if (!Object.hasOwn(PIPELINE_STAGES, stage.stage)) {
    throw StageError(stage.stage);
  }
  return PIPELINE_STAGES[stage.stage](relation, stage, context);
}

/** Folds the pipeline stages that follow a query's root prefix into one relation. */
export function ApplyStages(
  relation: Relation,
  stages: QueryStage[],
  context: DecodingContext,
): Relation {
  return stages.reduce(
    (current, stage) => ApplyStage(current, stage, context),
    relation,
  );
}

/** Refuses a nested query that ends in a write, naming the stage rather than the value. */
function RefuseNestedWrite(write: QueryStage): never {
  throw new Error(
    `The '${write.stage}' stage writes, so it cannot be nested inside another query`,
  );
}

/**
 * Compiles a whole query nested inside another one, root prefix and all: the one door a union's
 * other side and a correlated subquery take, wired onto the context so no stage family imports
 * this module. `RunQuery` does not use it, because it splits a terminal write off between the root
 * and the fold and needs the root's instance for the write.
 */
export function CompileRelation(
  stages: QueryStage[],
  context: DecodingContext,
): Relation {
  const root = BuildRoot(stages, context);
  const split = SplitWrite(root.rest);
  if (split.write) {
    RefuseNestedWrite(split.write);
  }
  return ApplyStages(root.relation, split.pipeline, context);
}
