import type { QueryStage } from "@antelopejs/interface-database/common";

import type { Dialect } from "../../dialect";
import type { Compiled } from "./sql";
import { DecodeValue } from "./value";
import type { DecodingContext } from "./context";
import { JsonRowSource, type RowSource } from "./row-source";
import { IsString } from "./guards";
import { ClassifyMember, StageOperand } from "./member";

/**
 * Accumulator threaded through the stages of one expression.
 *
 * `current` is a {@link RowSource} only while the expression is still addressing a row, which is
 * what lets `obj_index` reach a typed column instead of a JSON path. `timezone` is a pending zone
 * recorded by `date_with_timezone` and consumed by the date-part stages.
 */
export interface ExpressionState {
  current?: Compiled | RowSource;
  timezone?: string;
}

export type StageHandler = (
  state: ExpressionState,
  stage: QueryStage,
  context: DecodingContext,
) => ExpressionState;

export type StageMap = Record<string, StageHandler>;

export type ValueStage = (
  value: Compiled,
  args: readonly (Compiled | undefined)[],
  stage: QueryStage,
  context: DecodingContext,
) => Compiled;

export const FIRST_OPERAND = 0;
export const SECOND_OPERAND = 1;

const EMPTY_STATE = "Expression has no value to operate on";

function RequireCurrent(state: ExpressionState): Compiled | RowSource {
  if (!state.current) {
    throw new Error(EMPTY_STATE);
  }
  return state.current;
}

function IsCompiled(current: Compiled | RowSource): current is Compiled {
  return "sql" in current;
}

export function AsValue(state: ExpressionState): Compiled {
  const current = RequireCurrent(state);
  return IsCompiled(current) ? current : current.toJson();
}

export function AsSource(state: ExpressionState, dialect: Dialect): RowSource {
  const current = RequireCurrent(state);
  return IsCompiled(current) ? new JsonRowSource(dialect, current) : current;
}

export function RequireOperand(
  value: Compiled | undefined,
  stage: QueryStage,
  index: number,
): Compiled {
  if (!value) {
    throw new Error(
      `Stage '${stage.stage}' requires an operand at position ${index}`,
    );
  }
  return value;
}

/** Decodes the operand a stage records at `index`; `undefined` where it records none. */
export function DecodeOperand(
  stage: QueryStage,
  index: number,
  context: DecodingContext,
): Compiled | undefined {
  return DecodeValue(ClassifyMember(StageOperand(stage, index)), context);
}

/**
 * Reads an argument that is a literal list of field *names* rather than a value. Decoding it would
 * bind values no fragment references, so every stage taking a field list reads it through here.
 */
export function FieldNames(
  stage: QueryStage,
  index: number = FIRST_OPERAND,
): string[] {
  const fields: unknown = stage.args[index];
  const named = Array.isArray(fields) && fields.every(IsString);
  if (!named) {
    throw new Error(`Stage '${stage.stage}' requires a list of field names`);
  }
  return fields;
}

/**
 * Adapts a value-level handler into a {@link StageHandler} for a stage whose arguments are all
 * *values*: materializes the accumulator, decodes every argument and drops any pending timezone.
 */
export function Lift(handler: ValueStage): StageHandler {
  return (state, stage, context) => {
    const value = AsValue(state);
    const args = stage.args.map((_, index) =>
      DecodeOperand(stage, index, context),
    );
    return { current: handler(value, args, stage, context) };
  };
}

/** Builds one handler per entry of an operator table, so a family declares only its table. */
export function BuildStages<Operator>(
  operators: Record<string, Operator>,
  build: (operator: Operator) => StageHandler,
) {
  const stages: StageMap = {};
  for (const [name, operator] of Object.entries(operators)) {
    stages[name] = build(operator);
  }
  return stages;
}

/**
 * Resolves the field a stage names against a row source, branching on the **raw** argument: a
 * literal name goes to `field`, which keeps `key("price")` a typed column an index can serve, and
 * only a recorded expression falls through to the dynamic lookup out of a materialized document.
 */
export function FieldOf(
  source: RowSource,
  stage: QueryStage,
  context: DecodingContext,
): Compiled {
  const def = DecodeOperand(stage, SECOND_OPERAND, context);
  const name = StageOperand(stage, FIRST_OPERAND);
  if (IsString(name)) {
    return source.field(name, def);
  }
  const key = RequireOperand(
    DecodeValue(ClassifyMember(name), context),
    stage,
    FIRST_OPERAND,
  );
  return source.dynamicField(key, def);
}
