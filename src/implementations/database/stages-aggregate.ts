import assert from "node:assert";
import type { QueryStage } from "@antelopejs/interface-database/common";

import { sql } from "../../statement";
import type { Dialect } from "../../dialect";
import type { Compiled } from "./sql";
import { AsFloat } from "./readings";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import { type Relation, SetProjection } from "./relation";
import { AbsorbOrder, Prepare, type RelationFlag } from "./render";
import { IsString } from "./guards";
import { OptionsOf } from "./utils";

/**
 * An aggregate reads whichever rows the relation has already selected. `ordered` is deliberately
 * absent: an ordering cannot change an aggregate, so the terms clear.
 */
const AGGREGATE_BLOCKERS: readonly RelationFlag[] = [
  "projection",
  "limit",
  "offset",
  "distinct",
  "aggregated",
];

/**
 * The field an aggregate reads, or nothing for the whole-row reading. A name that is present and
 * not a string is a malformed stage, and reading it as absent would answer a different question.
 */
function NamedField(stage: QueryStage): string | undefined {
  const field: unknown = OptionsOf(stage)?.field;
  if (field === undefined) {
    return undefined;
  }
  assert(
    IsString(field),
    `The '${stage.stage}' stage was given a field that is not a name`,
  );
  return field;
}

/**
 * Counts rows, or the *distinct* values of an operand, as the contract asserts `count("car")`
 * against `new Set(cars).size`. The engine's count is an integer the driver hands back as text, so
 * it is read as a double.
 */
function Tally(dialect: Dialect, operand?: Compiled): Compiled {
  const counted = operand ? sql`COUNT(DISTINCT ${operand.sql})` : sql`COUNT(*)`;
  return AsFloat(dialect, counted);
}

/** Moves the relation into value mode over the one row an aggregate yields, clearing the order. */
function SetAggregate(relation: Relation, value: Compiled): Relation {
  const aggregate = SetProjection(relation, value);
  AbsorbOrder(aggregate);
  aggregate.single = true;
  aggregate.aggregated = true;
  return aggregate;
}

/** The one aggregate that reads the *presence* of its field rather than the field. */
const CountStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, AGGREGATE_BLOCKERS, context);
  const field = NamedField(stage);
  const operand =
    field === undefined ? undefined : prepared.source.field(field);
  return SetAggregate(prepared, Tally(context.dialect, operand));
};

/**
 * The stream aggregates implemented so far. `sum`, `avg`, `min`, `max` and `distinct` belong to
 * the same family and are named in the pipeline's deferred stages until they are added here.
 */
export const AGGREGATE_STAGES: PipelineStageMap = {
  count: CountStage,
};
