import type {
  QueryStage,
  QueryValue,
} from "@antelopejs/interface-database/common";

import { Bind, type Sql, sql } from "../../statement";
import { Cast, Unify } from "./coerce";
import type { DecodingContext } from "./context";
import { CompileExpression } from "./expression";
import { DeclaredColumns } from "./fields";
import { ClassifyMember, StageOperand } from "./member";
import { Predicate } from "./readings";
import { type Relation, RequireOrigin } from "./relation";
import { Extended } from "./render";
import type { RowSource } from "./row-source";
import { type RootSelection, WalkStages } from "./selection";
import { type Compiled, QualifiedColumn } from "./sql";
import { FIRST_OPERAND } from "./stage";
import { Identical } from "./stages-core";
import { IsJsonBacked } from "./types";
import { ID_COLUMN } from "./utils";
import {
  FUNCTION_BODY,
  ParameterKey,
  type RecordedFunction,
  WithBoundArguments,
} from "./value";

const LEFT_ROW = 0;
const JOINED_ROW = 1;

/**
 * A join condition that is one equality between a read of the left row and a read of the joined
 * row, each operand as the stages that compute it. `joinedFirst` says the joined row's read is the
 * one `eq` was called on.
 */
interface KeyedEquality {
  readonly left: QueryStage[];
  readonly joined: QueryStage[];
  readonly joinedFirst: boolean;
}

/** The stages of a recorded value, where it is a value chain rather than a constant. */
function ChainOf(value: QueryValue): QueryStage[] | undefined {
  const member = ClassifyMember(value);
  return member.kind === "proxy" ? member.value.build() : undefined;
}

/** The lambda parameters a chain reads, among those of the condition, by their keys. */
function ParametersRead(stages: QueryStage[], keys: string[]): Set<string> {
  const read = new Set<string>();
  WalkStages(stages, (stage) => {
    if (stage.stage !== "arg") {
      return;
    }
    const key = ParameterKey(StageOperand(stage, FIRST_OPERAND));
    if (keys.includes(key)) {
      read.add(key);
    }
  });
  return read;
}

function ReadsOnly(stages: QueryStage[], keys: string[], key: string): boolean {
  const read = ParametersRead(stages, keys);
  return read.size === 1 && read.has(key);
}

/**
 * The condition split at its equality, where it is `a.eq(b)` with one operand reading only the left
 * row and the other only the joined row; anything else answers nothing.
 */
function KeyedEqualityOf(
  condition: RecordedFunction,
): KeyedEquality | undefined {
  const body = ChainOf(condition.args[FUNCTION_BODY]);
  const last = body?.at(-1);
  if (!body || last?.stage !== "eq" || last.args.length !== 1) {
    return undefined;
  }
  const receiver = body.slice(0, -1);
  const argument = ChainOf(StageOperand(last, FIRST_OPERAND));
  if (!argument) {
    return undefined;
  }
  const keys = condition.args[0].map(ParameterKey);
  const [left, joined] = [keys[LEFT_ROW], keys[JOINED_ROW]];
  if (ReadsOnly(receiver, keys, joined) && ReadsOnly(argument, keys, left)) {
    return { left: argument, joined: receiver, joinedFirst: true };
  }
  if (ReadsOnly(receiver, keys, left) && ReadsOnly(argument, keys, joined)) {
    return { left: receiver, joined: argument, joinedFirst: false };
  }
  return undefined;
}

/** The query being joined as a FROM item at a fresh alias, and the condition its rows join on. */
export interface JoinedSide {
  readonly relation: Relation;
  readonly on: Sql;
}

/** Whether a value is a column of the table read as stored, which costs no more read again. */
function IsStoredColumn(table: Relation, value: Sql): boolean {
  const text = Bind(value).sql;
  const columns = [ID_COLUMN, ...DeclaredColumns(RequireOrigin(table).model)];
  return columns.some(
    (column) => Bind(QualifiedColumn(table.alias, column)).sql === text,
  );
}

/**
 * The table joined as a derived table of its rows in the instance, each with the joined row's
 * operand of the equality computed once, and the equality on that column. Answers nothing where
 * the engine computes it once per row already, where the operand is a stored column, or where the
 * operands compare as JSON, which a column of the derived table would hold as text.
 */
export function KeyedSide(
  condition: RecordedFunction,
  root: RootSelection,
  left: RowSource,
  context: DecodingContext,
): JoinedSide | undefined {
  const { dialect } = context;
  const unmerged = dialect.sql.rows.unmerged;
  const equality = unmerged ? KeyedEqualityOf(condition) : undefined;
  if (!unmerged || !equality) {
    return undefined;
  }
  const [own, other] = WithBoundArguments(
    condition,
    context,
    [left, root.relation.source],
    () => [
      CompileExpression(equality.joined, context),
      CompileExpression(equality.left, context),
    ],
  );
  const type = Unify(own.type, other.type);
  const key = Cast(dialect, own, type).sql;
  if (IsJsonBacked(type) || IsStoredColumn(root.relation, key)) {
    return undefined;
  }
  const keyed = Extended(root.relation, key, "_key", context, unmerged);
  const column: Compiled = { sql: keyed.column, type };
  const matched = equality.joinedFirst
    ? Identical(dialect, column, other)
    : Identical(dialect, other, column);
  return {
    relation: keyed.relation,
    on: sql`(${Predicate(dialect, matched).sql})`,
  };
}
