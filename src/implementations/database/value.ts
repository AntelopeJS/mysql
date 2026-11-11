import assert from "node:assert";
import type {
  QueryStage,
  QueryValue,
} from "@antelopejs/interface-database/common";

import { Cast, UnifyAll } from "./coerce";
import type { ArgumentBinding, DecodingContext } from "./context";
import {
  BooleanParam,
  type Compiled,
  type ConstantJson,
  InstantParam,
  JsonParam,
  NumberParam,
  TextParam,
} from "./sql";
import {
  ArrayOf,
  BOOL,
  FLOAT,
  JsonOf,
  OPAQUE,
  type SqlType,
  TEXT,
} from "./types";
import {
  ClassifyMember,
  IsList,
  IsOperandRecord,
  type ListMember,
  type Member,
  StageOperand,
} from "./member";
import type { Dialect } from "../../dialect";
import { IsBoolean, IsNumber, IsString } from "./guards";

/**
 * The JSON null every `null` in a query decodes to, one object per dialect, so an operator that
 * needs to recognise a null literal — `eq` and `ne` — can detect it by identity.
 */
const NULL_JSONS = new WeakMap<Dialect, Compiled>();

export function NullJson(dialect: Dialect): Compiled {
  const known = NULL_JSONS.get(dialect);
  if (known) {
    return known;
  }
  const created: Compiled = { sql: dialect.sql.json.null, type: OPAQUE };
  NULL_JSONS.set(dialect, created);
  return created;
}

/**
 * Turn a value handed to the query builder into a SQL fragment.
 *
 * `undefined` decodes to `undefined` — absence, which the caller interprets — while `null`
 * decodes to a JSON null, since a JSON member set to null is not SQL NULL.
 *
 * Every case here that *recurses* — a list, a record, and a staged value handed to a compiler —
 * must stay covered by `selection.ts`'s `CollectValue`, which gates schema readiness by walking
 * the same shapes before any of this runs.
 */
export function DecodeValue(
  value: Member,
  context: DecodingContext,
): Compiled | undefined {
  const dialect = context.dialect;
  switch (value.kind) {
    case "absent":
      return undefined;
    case "null":
      return NullJson(dialect);
    case "proxy":
      return context.expression(value.value.build());
    case "query":
      return context.subquery(value.value.build());
    case "date":
      return InstantParam(dialect, value.value);
    case "list":
      return DecodeArray(value, context);
    case "record":
      return DecodeEntries(value.document.entries(), context);
    case "text":
      return TextParam(dialect, value.value);
    case "number":
      return NumberParam(dialect, value.value);
    case "boolean":
      return BooleanParam(dialect, value.value);
    case "staged":
    case "opaque":
      return value.refuseInQuery();
    default:
      return value satisfies never;
  }
}

/** The type {@link DecodeValue} would give a constant, read off the value instead of the SQL. */
function ConstantType(value: ConstantJson): SqlType {
  if (value === null) {
    return OPAQUE;
  }
  if (Array.isArray(value)) {
    return ArrayOf(UnifyAll(value.map(ConstantType)));
  }
  if (IsString(value)) {
    return TEXT;
  }
  if (IsNumber(value)) {
    return FLOAT;
  }
  if (IsBoolean(value)) {
    return BOOL;
  }
  return ConstantRecordType(value);
}

function ConstantRecordType(value: {
  [key: string]: ConstantJson | undefined;
}): SqlType {
  const keyTypes: Record<string, SqlType> = {};
  for (const [name, item] of Object.entries(value)) {
    if (item !== undefined) {
      keyTypes[name] = ConstantType(item);
    }
  }
  return JsonOf(keyTypes);
}

/**
 * A list of constants binds as one JSON parameter, where a list of expressions cannot: the lists
 * callers pass are the ones they did not count, like every route of an application, and one
 * argument keeps the statement the same size whatever the list's length.
 */
function DecodeArray(list: ListMember, context: DecodingContext): Compiled {
  const constant = list.constant();
  if (constant) {
    const type = ArrayOf(UnifyAll(constant.map(ConstantType)));
    return JsonParam(context.dialect, constant, type);
  }
  const items = list
    .items()
    .map((item) => DecodeValue(item, context) ?? NullJson(context.dialect));
  const elem = UnifyAll(items.map((item) => item.type));
  const parts = items.map((item) => Cast(context.dialect, item, OPAQUE).sql);
  return { sql: context.dialect.sql.json.array(parts), type: ArrayOf(elem) };
}

/** A document built from named members, each read as JSON; an absent member is left out. */
function DecodeEntries(
  entries: [string, Member][],
  context: DecodingContext,
): Compiled {
  const parts: [string, Compiled["sql"]][] = [];
  const keyTypes: Record<string, SqlType> = {};
  for (const [name, item] of entries) {
    const compiled = DecodeValue(item, context);
    if (!compiled) {
      continue;
    }
    parts.push([name, Cast(context.dialect, compiled, OPAQUE).sql]);
    keyTypes[name] = compiled.type;
  }
  return {
    sql: context.dialect.sql.json.object(parts),
    type: JsonOf(keyTypes),
  };
}

const FUNCTION_STAGE = "func";
const PARAMETER_IDS = 0;
export const FUNCTION_BODY = 1;

/** A lambda the query builder recorded: the ids of its parameters, then the body they are bound in. */
export type RecordedFunction = {
  readonly stage: typeof FUNCTION_STAGE;
  readonly args: readonly [ids: readonly QueryValue[], body: QueryValue];
};

/**
 * The text a lambda parameter is bound under: its id as a property key spells it, which is what a
 * `func` rebuilt from JSON still agrees on with the `arg` stages inside it.
 */
export function ParameterKey(id: QueryValue): string {
  return IsString(id) ? id : (JSON.stringify(id) ?? "");
}

/**
 * Whether an operand is a `func` stage whose parameter ids are a list. A stage that takes only a
 * callback accepts whatever ids a `func` rebuilt from JSON may carry, which are bound by their text.
 * The body is an operand like any other, which is the type the operand already has.
 */
function IsLambdaStage(value: QueryValue): value is RecordedFunction {
  if (!IsOperandRecord(value) || value.stage !== FUNCTION_STAGE) {
    return false;
  }
  const args = value.args;
  return IsList(args) && IsList(args[PARAMETER_IDS]);
}

function IsNumberId(id: QueryValue): id is number {
  return typeof id === "number";
}

/**
 * Whether an operand is a lambda a caller recorded, for `update`, the one stage taking either a
 * lambda or a plain document. The parameter ids are read as well as the stage name, because they
 * are the half no caller's own document plausibly carries.
 */
export function IsRecordedFunction(
  value: QueryValue,
): value is RecordedFunction {
  return IsLambdaStage(value) && value.args[PARAMETER_IDS].every(IsNumberId);
}

/** The lambda a stage records as its argument at `index`, refused by name when it is anything else. */
export function RecordedLambda(
  stage: QueryStage,
  index: number,
): RecordedFunction {
  const lambda = StageOperand(stage, index);
  assert(IsLambdaStage(lambda), `Stage '${stage.stage}' requires a callback`);
  return lambda;
}

/**
 * Runs a compilation with a recorded lambda's parameters bound to the given row sources or
 * subquery providers, and unbound again however it ends.
 */
export function WithBoundArguments<T>(
  func: RecordedFunction,
  context: DecodingContext,
  bindings: ArgumentBinding[],
  compile: () => T,
): T {
  const ids = func.args[PARAMETER_IDS];
  const missing = ids.findIndex((_, index) => !bindings[index]);
  if (missing >= 0) {
    throw new Error(`Missing binding for lambda parameter ${missing}`);
  }
  ids.forEach((id, index) => {
    context.bind(ParameterKey(id), bindings[index]);
  });
  try {
    return compile();
  } finally {
    ids.forEach((id) => {
      context.unbind(ParameterKey(id));
    });
  }
}

/** Decodes the body of a recorded lambda with its parameters bound for the duration. */
export function DecodeFunction(
  func: RecordedFunction,
  context: DecodingContext,
  bindings: ArgumentBinding[],
): Compiled | undefined {
  return WithBoundArguments(func, context, bindings, () =>
    DecodeValue(ClassifyMember(func.args[FUNCTION_BODY]), context),
  );
}
