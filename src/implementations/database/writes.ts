import assert from "node:assert";
import type { QueryStage } from "@antelopejs/interface-database/common";

import { InsertWrite } from "./writes-insert";
import type { DecodingContext } from "./context";
import { ATOMIC_MUTATION, AtomicWrite } from "./writes-atomic";
import { DeleteWrite, ReplaceWrite, UpdateWrite } from "./writes-identity";
import type {
  WriteCompiler,
  WriteStatement,
  WriteTarget,
} from "./writes-shared";

/**
 * One terminal stage, and whether it reads the rows it is applied to: a write that ignores the
 * relation may not follow a stage that shaped one. Stated beside the compiler, so a new write is
 * registered in one place.
 */
interface WriteSpec {
  compile: WriteCompiler;
  readsRelation: boolean;
}

/** A query's pipeline stages, and the terminal write that follows them if there is one. */
export interface WriteSplit {
  pipeline: QueryStage[];
  write?: QueryStage;
}

/** The terminal stages, each compiling a statement that is not a `SELECT`. */
const WRITE_STAGES = new Map<string, WriteSpec>([
  [ATOMIC_MUTATION, { compile: AtomicWrite, readsRelation: false }],
  ["insert", { compile: InsertWrite, readsRelation: false }],
  ["update", { compile: UpdateWrite, readsRelation: true }],
  ["replace", { compile: ReplaceWrite, readsRelation: true }],
  ["delete", { compile: DeleteWrite, readsRelation: true }],
]);

function RefuseWrites(stages: QueryStage[]): void {
  for (const stage of stages) {
    assert(
      !WRITE_STAGES.has(stage.stage),
      `The '${stage.stage}' stage writes and can only be the last stage of a query`,
    );
  }
}

/** Refuses a write that would silently drop the pipeline it follows, naming every discarded stage. */
function RefuseDiscardedStages(
  write: QueryStage,
  spec: WriteSpec,
  pipeline: QueryStage[],
): void {
  if (spec.readsRelation || pipeline.length === 0) {
    return;
  }
  const discarded = pipeline.map((stage) => `'${stage.stage}'`).join(", ");
  throw new Error(
    `The '${write.stage}' stage does not read the rows it is applied to, so every stage before it would be discarded: ${discarded}`,
  );
}

/**
 * Separates a query's terminal write from the pipeline that precedes it. A write produces a
 * statement rather than a relation, so the fold never sees it, and a write anywhere but last is an
 * error naming it.
 */
export function SplitWrite(stages: QueryStage[]): WriteSplit {
  const last = stages.at(-1);
  const spec = last ? WRITE_STAGES.get(last.stage) : undefined;
  if (!last || !spec) {
    RefuseWrites(stages);
    return { pipeline: stages };
  }
  const pipeline = stages.slice(0, -1);
  RefuseWrites(pipeline);
  RefuseDiscardedStages(last, spec, pipeline);
  return { pipeline, write: last };
}

export function CompileWrite(
  target: WriteTarget,
  stage: QueryStage,
  context: DecodingContext,
): WriteStatement {
  const spec = WRITE_STAGES.get(stage.stage);
  assert(spec, `Unsupported write stage '${stage.stage}'`);
  return spec.compile(target, stage, context);
}
