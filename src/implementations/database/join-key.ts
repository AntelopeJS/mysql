import type {
  QueryStage,
  QueryValue,
} from "@antelopejs/interface-database/common";

import { Bind, type Sql, join, sql } from "../../statement";
import { Cast, Unify } from "./coerce";
import type { DecodingContext } from "./context";
import { CompileExpression } from "./expression";
import { DeclaredColumns } from "./fields";
import { ClassifyMember, StageOperand } from "./member";
import { Predicate } from "./readings";
import { type Relation, RequireOrigin } from "./relation";
import { FromItem, KeyedIdentities } from "./render";
import type { RowSource } from "./row-source";
import { type RootSelection, WalkStages } from "./selection";
import { type Compiled, QualifiedColumn } from "./sql";
import { FIRST_OPERAND } from "./stage";
import { Identical } from "./stages-core";
import { IsJsonBacked } from "./types";
import { ID_COLUMN, INSTANCE_COLUMN } from "./utils";
import {
  FUNCTION_BODY,
  IsRecordedFunction,
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

/**
 * The lambda parameters a chain reads that no lambda inside it binds, by their keys: those of the
 * condition, and those of any lambda the join is nested in.
 */
function FreeParameters(stages: QueryStage[]): Set<string> {
  const read = new Set<string>();
  const bound = new Set<string>();
  WalkStages(stages, (stage) => {
    if (stage.stage === "arg") {
      read.add(ParameterKey(StageOperand(stage, FIRST_OPERAND)));
    }
    stage.args.forEach((_, index) => {
      const operand = StageOperand(stage, index);
      if (IsRecordedFunction(operand)) {
        operand.args[0].forEach((id) => bound.add(ParameterKey(id)));
      }
    });
  });
  return new Set([...read].filter((key) => !bound.has(key)));
}

function ReadsOnly(stages: QueryStage[], key: string): boolean {
  const read = FreeParameters(stages);
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
  const [left, joined] = [LEFT_ROW, JOINED_ROW].map((row) =>
    ParameterKey(condition.args[0][row]),
  );
  if (ReadsOnly(receiver, joined) && ReadsOnly(argument, left)) {
    return { left: argument, joined: receiver, joinedFirst: true };
  }
  if (ReadsOnly(receiver, left) && ReadsOnly(argument, joined)) {
    return { left: receiver, joined: argument, joinedFirst: false };
  }
  return undefined;
}

/**
 * The query being joined, the FROM item that brings it in, and the condition its rows join on. The
 * item names the relation at its alias, or more where a join needs it.
 */
export interface JoinedSide {
  readonly relation: Relation;
  readonly item: Sql;
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

const KEY_COLUMN = "_key";

/**
 * The table joined through a derived table of the identities of its rows in the instance, each with
 * the joined row's operand of the equality computed once, and the equality on that column; the
 * table itself is joined back by its primary key, so the derived table holds no document. Answers
 * nothing where the engine computes the operand once per row already, where the operand is a
 * stored column, or where the operands compare as JSON, which a column of the derived table would
 * hold as text.
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
  const table = root.relation;
  const [own, other] = WithBoundArguments(
    condition,
    context,
    [left, table.source],
    () => [
      CompileExpression(equality.joined, context),
      CompileExpression(equality.left, context),
    ],
  );
  const type = Unify(own.type, other.type);
  const key = Cast(dialect, own, type).sql;
  if (IsJsonBacked(type) || IsStoredColumn(table, key)) {
    return undefined;
  }
  const keys = context.nextAlias();
  const select = KeyedIdentities(table, key, KEY_COLUMN);
  const identity = [INSTANCE_COLUMN, ID_COLUMN].map(
    (column) =>
      sql`${QualifiedColumn(table.alias, column)} = ${QualifiedColumn(keys, column)}`,
  );
  const column: Compiled = { sql: QualifiedColumn(keys, KEY_COLUMN), type };
  const matched = equality.joinedFirst
    ? Identical(dialect, column, other)
    : Identical(dialect, other, column);
  return {
    relation: table,
    item: sql`(${FromItem(sql`(${unmerged(select)})`, keys)} JOIN ${FromItem(table.from, table.alias)} ON ${join(identity, sql` AND `)})`,
    on: sql`(${Predicate(dialect, matched).sql})`,
  };
}
