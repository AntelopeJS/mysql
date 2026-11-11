import type { QueryStage } from "@antelopejs/interface-database/common";

import type { Compiled } from "./sql";
import { CORE_STAGES } from "./stages-core";
import type { RowSource } from "./row-source";
import type { DecodingContext } from "./context";
import { AsValue, type ExpressionState, type StageMap } from "./stage";

/**
 * The expression stage vocabulary: one family per module, merged here. A family this module does
 * not merge yet is named in {@link DEFERRED_EXPRESSION_STAGES}, and adding one is adding its module
 * and spreading it here.
 */
const STAGES: StageMap = {
  ...CORE_STAGES,
};

const NUMERIC = "numeric";
const STRING = "string";
const DATE = "date";
const ARRAY = "array";
const OBJECT = "object";

/** The expression stages whose family is not implemented yet, by the family that will own them. */
export const DEFERRED_EXPRESSION_STAGES: ReadonlyMap<string, string> = new Map([
  ["add", NUMERIC],
  ["sub", NUMERIC],
  ["mul", NUMERIC],
  ["div", NUMERIC],
  ["mod", NUMERIC],
  ["round", NUMERIC],
  ["ceil", NUMERIC],
  ["floor", NUMERIC],
  ["bit_and", NUMERIC],
  ["bit_or", NUMERIC],
  ["bit_xor", NUMERIC],
  ["bit_not", NUMERIC],
  ["bit_lshift", NUMERIC],
  ["bit_rshift", NUMERIC],
  ["str_split", STRING],
  ["str_concat", STRING],
  ["str_upcase", STRING],
  ["str_downcase", STRING],
  ["str_len", STRING],
  ["str_match", STRING],
  ["date_during", DATE],
  ["date_with_timezone", DATE],
  ["date_tod", DATE],
  ["date_year", DATE],
  ["date_month", DATE],
  ["date_day", DATE],
  ["date_dow", DATE],
  ["date_doy", DATE],
  ["date_hours", DATE],
  ["date_minutes", DATE],
  ["date_seconds", DATE],
  ["date_epoch", DATE],
  ["arr_index", ARRAY],
  ["arr_includes", ARRAY],
  ["arr_slice", ARRAY],
  ["arr_map", ARRAY],
  ["arr_filter", ARRAY],
  ["arr_empty", ARRAY],
  ["arr_count", ARRAY],
  ["arr_sum", ARRAY],
  ["arr_avg", ARRAY],
  ["arr_min", ARRAY],
  ["arr_max", ARRAY],
  ["obj_merge", OBJECT],
  ["obj_keys", OBJECT],
  ["obj_values", OBJECT],
  ["obj_has", OBJECT],
]);

function UnsupportedStage(name: string): Error {
  const family = DEFERRED_EXPRESSION_STAGES.get(name);
  if (family !== undefined) {
    return new Error(
      `The '${name}' expression stage (${family} family) is not implemented by @antelopejs/mysql yet`,
    );
  }
  return new Error(`Unsupported expression stage '${name}'`);
}

/**
 * Folds a recorded `ValueProxy` chain into one SQL fragment. `source` seeds the accumulator with
 * the row a lambda is compiled against, so an expression that opens on `obj_index` reaches a typed
 * column rather than a materialized document.
 */
export function CompileExpression(
  stages: QueryStage[],
  context: DecodingContext,
  source?: RowSource,
): Compiled {
  let state: ExpressionState = { current: source };
  for (const stage of stages) {
    if (!Object.hasOwn(STAGES, stage.stage)) {
      throw UnsupportedStage(stage.stage);
    }
    state = STAGES[stage.stage](state, stage, context);
  }
  return AsValue(state);
}
