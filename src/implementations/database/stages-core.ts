import assert from "node:assert";
import { IsQueryStage } from "@antelopejs/interface-database/common";

import { type Sql, sql } from "../../statement";
import type { Dialect } from "../../dialect";
import type { Compiled } from "./sql";
import { AsJson, Predicate } from "./readings";
import { IsNullJson, ParameterKey } from "./value";
import { Compare, Compared, type Ordering } from "./json";
import { BOOL, IsJsonBacked, IsOpaque, OPAQUE } from "./types";
import { type CompiledPair, UnifyOperands, WithDefault } from "./coerce";
import {
  AsSource,
  BuildStages,
  DecodeOperand,
  FIRST_OPERAND,
  FieldOf,
  Lift,
  RequireOperand,
  type StageHandler,
  type StageMap,
} from "./stage";
import { IsSubqueryProvider } from "./context";

type Equality = (
  dialect: Dialect,
  value: Compiled,
  other: Compiled,
) => Compiled;

interface EqualityOperator {
  compare: Equality;
  negated: boolean;
}

const BOOLEAN_OPERATORS = {
  and: sql`AND`,
  or: sql`OR`,
};

const ORDERING_OPERATORS = {
  cmp_gt: ">",
  cmp_ge: ">=",
  cmp_lt: "<",
  cmp_le: "<=",
} as const satisfies Record<string, Ordering>;

const ArgStage: StageHandler = (_state, stage, context) => {
  assert(IsQueryStage(stage, "arg"), "The 'arg' stage reads an 'arg' stage");
  const binding = context.arg(ParameterKey(stage.args[FIRST_OPERAND]));
  if (IsSubqueryProvider(binding)) {
    return { current: binding([stage]) };
  }
  return { current: binding };
};

const ConstantStage: StageHandler = (_state, stage, context) => ({
  current: RequireOperand(
    DecodeOperand(stage, FIRST_OPERAND, context),
    stage,
    FIRST_OPERAND,
  ),
});

/**
 * Reads a member of the accumulator: a row's own typed column while the expression still addresses
 * a row, and a member of the JSON value otherwise.
 */
const ObjIndexStage: StageHandler = (state, stage, context) => ({
  current: FieldOf(AsSource(state, context.dialect), stage, context),
});

/**
 * The fallback a value takes when it is null, at whatever type the two of them meet. Not
 * `Defaulted`: this default is an alternative value, not one of the column's type.
 */
const DefaultStage = Lift((value, args, _stage, context) =>
  WithDefault(context.dialect, value, args[FIRST_OPERAND]),
);

/**
 * Negates a condition the way JavaScript's `!` does, where the operand may be neither true nor
 * false: `NOT NULL` is NULL and would drop the row, so `IS NOT TRUE` is the total spelling.
 */
const NotStage = Lift((value, _args, _stage, context) => ({
  sql: sql`(${Predicate(context.dialect, value).sql} IS NOT TRUE)`,
  type: BOOL,
}));

function BooleanStage(operator: Sql): StageHandler {
  return Lift((value, args, stage, context) => {
    const other = RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND);
    const dialect = context.dialect;
    return {
      sql: sql`(${Predicate(dialect, value).sql} ${operator} ${Predicate(dialect, other).sql})`,
      type: BOOL,
    };
  });
}

/** A test that holds only where the native columns a pair compares bare hold a value a read answers. */
function WherePresent(pair: CompiledPair, test: Sql): Sql {
  return pair.present ? sql`(${pair.present} AND ${test})` : test;
}

function Comparison(
  dialect: Dialect,
  value: Compiled,
  other: Compiled,
  operator: Ordering,
): Compiled {
  const pair = UnifyOperands(dialect, value, other, operator);
  const compared = Compare(dialect, pair.left, pair.right, operator);
  return { sql: WherePresent(pair, compared), type: BOOL };
}

/** `value.eq(other)` between two operands that are both values, neither of them `null`. */
export const Identical: Equality = (dialect, value, other) =>
  Comparison(dialect, value, other, "=");

/**
 * Operands for an inequality, the one comparison that must answer for a value it cannot read.
 * Exactly one bottom-typed side compares as JSON, where no type guard can reject the other.
 */
function Distinguishable(
  dialect: Dialect,
  value: Compiled,
  other: Compiled,
): CompiledPair {
  if (IsOpaque(value.type) === IsOpaque(other.type)) {
    return UnifyOperands(dialect, value, other);
  }
  return {
    left: AsJson(dialect, value),
    right: AsJson(dialect, other),
    type: OPAQUE,
  };
}

/**
 * Compares two values for inequality, keeping a row whose operand is null or absent: `<>` is NULL
 * whenever either side is, so the negated null-safe equality is the total spelling.
 *
 * Against a converted operand it is the complement of equality instead: the conversion answers
 * NULL for a value the column's type cannot hold, and a null-safe test would then drop every row
 * whose column is NULL too.
 */
const Distinct: Equality = (dialect, value, other) => {
  const pair = Distinguishable(dialect, value, other);
  if (pair.converted) {
    const same = sql`(${Compared(dialect, pair.left, pair.right, "=")})`;
    return { sql: sql`(${WherePresent(pair, same)} IS NOT TRUE)`, type: BOOL };
  }
  const same = IsJsonBacked(pair.type)
    ? dialect.sql.json.same(pair.left.sql, pair.right.sql)
    : dialect.sql.rows.nullSafeEqual(pair.left.sql, pair.right.sql);
  return { sql: sql`(NOT ${same})`, type: BOOL };
};

const EQUALITY_OPERATORS = {
  eq: { compare: Identical, negated: false },
  ne: { compare: Distinct, negated: true },
} satisfies Record<string, EqualityOperator>;

/**
 * A JSON null is not SQL NULL, and a declared column holding SQL NULL is not a JSON null, so a
 * comparison against `null` reads both spellings rather than unify toward the operand's type.
 */
function NullTest(
  dialect: Dialect,
  value: Compiled,
  negated: boolean,
): Compiled {
  const test = IsJsonBacked(value.type)
    ? dialect.sql.json.absent(value.sql)
    : sql`(${value.sql} IS NULL)`;
  return { sql: negated ? sql`(NOT ${test})` : test, type: BOOL };
}

function EqualityStage(operator: EqualityOperator): StageHandler {
  return Lift((value, args, stage, context) => {
    const dialect = context.dialect;
    const other = RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND);
    if (IsNullJson(dialect, other)) {
      return NullTest(dialect, value, operator.negated);
    }
    if (IsNullJson(dialect, value)) {
      return NullTest(dialect, other, operator.negated);
    }
    return operator.compare(dialect, value, other);
  });
}

function OrderingStage(operator: Ordering): StageHandler {
  return Lift((value, args, stage, context) =>
    Comparison(
      context.dialect,
      value,
      RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND),
      operator,
    ),
  );
}

export const CORE_STAGES: StageMap = {
  arg: ArgStage,
  constant: ConstantStage,
  default: DefaultStage,
  not: NotStage,
  obj_index: ObjIndexStage,
  ...BuildStages(BOOLEAN_OPERATORS, BooleanStage),
  ...BuildStages(EQUALITY_OPERATORS, EqualityStage),
  ...BuildStages(ORDERING_OPERATORS, OrderingStage),
};
