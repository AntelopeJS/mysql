import type { QueryStage } from "@antelopejs/interface-database/common";

import type { Dialect } from "../../dialect";
import type { Int32Syntax } from "../../dialect/sql-types";
import { type Sql, sql } from "../../statement";
import { Unify } from "./coerce";
import type { Compiled } from "./sql";
import { FLOAT, type SqlType, TEXT, TIMESTAMP } from "./types";
import {
  AsFloat,
  MILLISECONDS_PER_SECOND,
  Moment,
  Numeric,
  Text,
} from "./readings";
import { OptionsOf } from "./utils";
import {
  FIRST_OPERAND,
  Lift,
  RequireOperand,
  type StageHandler,
  type StageMap,
} from "./stage";

type Arithmetic = (
  dialect: Dialect,
  left: Compiled,
  right: Compiled,
  stage: QueryStage,
) => Compiled;

type OperandTable = Record<string, Arithmetic | null>;

type Rounding = (value: Sql) => Sql;

type Bitwise = (bits: Int32Syntax, left: Sql, right: Sql) => Sql;

interface OperandKinds {
  left: SqlType["kind"];
  right: SqlType["kind"];
  key: string;
}

const PLUS = sql`+`;
const MINUS = sql`-`;
const TIMES = sql`*`;

/** An instant moved by a number of seconds, through epoch milliseconds, SQL NULL beyond what an instant holds. */
function OffsetMoment(
  dialect: Dialect,
  moment: Compiled,
  seconds: Compiled,
  operator: Sql,
): Compiled {
  const time = dialect.sql.time;
  const shifted = sql`(${time.toEpochMs(Moment(dialect, moment).sql)} ${operator} ${Numeric(dialect, seconds).sql} * ${MILLISECONDS_PER_SECOND})`;
  return { sql: time.fromEpochMs(shifted), type: TIMESTAMP };
}

const ElapsedSeconds: Arithmetic = (dialect, left, right) => {
  const time = dialect.sql.time;
  const elapsed = sql`(${time.toEpochMs(Moment(dialect, left).sql)} - ${time.toEpochMs(Moment(dialect, right).sql)})`;
  return AsFloat(dialect, sql`(${elapsed} / ${MILLISECONDS_PER_SECOND})`);
};

const ConcatText: Arithmetic = (dialect, left, right) => ({
  sql: dialect.sql.scalar.concat([
    Text(dialect, left).sql,
    Text(dialect, right).sql,
  ]),
  type: TEXT,
});

/** A JSON `null` operand answers NULL, as every other `add` does, instead of becoming an element. */
const ConcatArray: Arithmetic = (dialect, left, right) => {
  const json = dialect.sql.json;
  return {
    sql: json.concatArrays(left.sql, json.present(right.sql)),
    type: Unify(left.type, right.type),
  };
};

const NO_READING = null;

/** A divisor that is zero read as absent, so the row yields NULL: see {@link NUMERIC_STAGES}. */
function NonZero(value: Sql): Sql {
  return sql`NULLIF(${value}, 0)`;
}

const Modulo: Arithmetic = (dialect, left, right) =>
  AsFloat(
    dialect,
    sql`MOD(${Numeric(dialect, left).sql}, ${NonZero(Numeric(dialect, right).sql)})`,
  );

const Divide: Arithmetic = (dialect, left, right) => ({
  sql: sql`(${Numeric(dialect, left).sql} / ${NonZero(Numeric(dialect, right).sql)})`,
  type: FLOAT,
});

function Infix(operator: Sql): Arithmetic {
  return (dialect, left, right) => ({
    sql: sql`(${Numeric(dialect, left).sql} ${operator} ${Numeric(dialect, right).sql})`,
    type: FLOAT,
  });
}

const ADD_OPERANDS = {
  "timestamp:float": (dialect, left, right) =>
    OffsetMoment(dialect, left, right, PLUS),
  "float:timestamp": (dialect, left, right) =>
    OffsetMoment(dialect, right, left, PLUS),
  "timestamp:timestamp": NO_READING,
  "text:text": ConcatText,
  "array:array": ConcatArray,
} satisfies OperandTable;

const SUB_OPERANDS = {
  "timestamp:float": (dialect, left, right) =>
    OffsetMoment(dialect, left, right, MINUS),
  "float:timestamp": NO_READING,
  "timestamp:timestamp": ElapsedSeconds,
  "text:text": NO_READING,
  "array:array": NO_READING,
} satisfies OperandTable;

const BOTTOM_PULL: Partial<Record<SqlType["kind"], SqlType["kind"]>> = {
  timestamp: "float",
};

function ResolvedKind(type: SqlType, other: SqlType): SqlType["kind"] {
  if (type.kind !== "json") {
    return type.kind;
  }
  return BOTTOM_PULL[other.kind] ?? other.kind;
}

function ResolveOperands(left: Compiled, right: Compiled): OperandKinds {
  const leftKind = ResolvedKind(left.type, right.type);
  const rightKind = ResolvedKind(right.type, left.type);
  return { left: leftKind, right: rightKind, key: `${leftKind}:${rightKind}` };
}

function BinaryStage(build: Arithmetic): StageHandler {
  return Lift((value, args, stage, context) =>
    build(
      context.dialect,
      value,
      RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND),
      stage,
    ),
  );
}

function PolymorphicStage(
  operands: OperandTable,
  fallback: Arithmetic,
): StageHandler {
  return BinaryStage((dialect, left, right, stage) => {
    const kinds = ResolveOperands(left, right);
    const build = Object.hasOwn(operands, kinds.key)
      ? operands[kinds.key]
      : fallback;
    if (!build) {
      throw new Error(
        `Stage '${stage.stage}' has no reading for a '${kinds.left}' and a '${kinds.right}'`,
      );
    }
    return build(dialect, left, right, stage);
  });
}

const NEAREST_INTEGER: Rounding = (value) => sql`FLOOR(${value} + 0.5)`;
const UPPER_INTEGER: Rounding = (value) => sql`CEIL(${value})`;
const LOWER_INTEGER: Rounding = (value) => sql`FLOOR(${value})`;

function RoundingStage(round: Rounding): StageHandler {
  return Lift((value, _args, _stage, context) =>
    AsFloat(context.dialect, round(Numeric(context.dialect, value).sql)),
  );
}

/** A number as `ToInt32` reads it, which the dialect's int32 members take as their operands. */
function Operand(dialect: Dialect, value: Compiled): Sql {
  return dialect.sql.scalar.int32.read(Numeric(dialect, value).sql);
}

function BitwiseStage(combine: Bitwise): StageHandler {
  return BinaryStage((dialect, left, right) =>
    AsFloat(
      dialect,
      combine(
        dialect.sql.scalar.int32,
        Operand(dialect, left),
        Operand(dialect, right),
      ),
    ),
  );
}

const BitNotStage = Lift((value, _args, _stage, context) =>
  AsFloat(
    context.dialect,
    context.dialect.sql.scalar.int32.not(Operand(context.dialect, value)),
  ),
);

const BitRshiftStage = BinaryStage((dialect, left, right, stage) => {
  const preserveSign: unknown = OptionsOf(stage)?.preserveSign;
  const bits = dialect.sql.scalar.int32;
  const value = Operand(dialect, left);
  const count = Operand(dialect, right);
  return AsFloat(
    dialect,
    preserveSign
      ? bits.shiftRight(value, count)
      : bits.shiftRightUnsigned(value, count),
  );
});

/**
 * Arithmetic and bitwise stages.
 *
 * - `round` is `FLOOR(x + 0.5)`, which is `Math.round`: halves go up, so `-2.5` is `-2`.
 * - The bitwise stages read each operand as JavaScript's `ToInt32` does, through the dialect,
 *   so they agree with JavaScript at every magnitude a double holds exactly. There is no NaN or
 *   infinity to read: the engine has neither.
 *
 * **`div` and `mod` read a zero divisor as absent**, through `NULLIF`, so the row answers NULL.
 * It is not an attempt to reproduce JavaScript, where `1/0` is `Infinity` and `1%0` is `NaN`:
 * neither is representable in a double here, and NULL is what every other unreadable operand in
 * this compiler already answers. A bare `/` in a write fails its statement under strict mode. The
 * guard is on the divisor alone, so it cannot cost an index.
 *
 * `add` and `sub` dispatch on the operand kinds *before* unifying, because two distinct concrete
 * kinds unify to the bottom type, which would compare a date against a number as JSON rather than
 * reading the number as seconds. A bottom-typed operand is resolved toward the other side first,
 * except against a `timestamp`, where it resolves to `float`: seconds is the only reading `add` and
 * `sub` share for a date, and it degrades to NULL for an operand that is not a number instead of
 * rejecting the pair outright.
 */
export const NUMERIC_STAGES: StageMap = {
  add: PolymorphicStage(ADD_OPERANDS, Infix(PLUS)),
  sub: PolymorphicStage(SUB_OPERANDS, Infix(MINUS)),
  mul: BinaryStage(Infix(TIMES)),
  div: BinaryStage(Divide),
  mod: BinaryStage(Modulo),
  round: RoundingStage(NEAREST_INTEGER),
  ceil: RoundingStage(UPPER_INTEGER),
  floor: RoundingStage(LOWER_INTEGER),
  bit_and: BitwiseStage((bits, left, right) => bits.and(left, right)),
  bit_or: BitwiseStage((bits, left, right) => bits.or(left, right)),
  bit_xor: BitwiseStage((bits, left, right) => bits.xor(left, right)),
  bit_not: BitNotStage,
  bit_lshift: BitwiseStage((bits, value, count) =>
    bits.shiftLeft(value, count),
  ),
  bit_rshift: BitRshiftStage,
};
