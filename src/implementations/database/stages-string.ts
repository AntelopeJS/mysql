import { type Sql, sql } from "../../statement";
import { TextParam } from "./sql";
import { AsFloat } from "./readings";
import { ArrayOf, BOOL, TEXT } from "./types";
import { IsString } from "./guards";
import { OptionsOf } from "./utils";
import { StageOperand } from "./member";
import {
  BuildStages,
  DecodeOperand,
  FIRST_OPERAND,
  Lift,
  LiftRaw,
  RequireOperand,
  TextOf,
  type StageHandler,
  type StageMap,
} from "./stage";

interface SplitOptions {
  separator?: string;
  maxSplits?: number;
}

const DEFAULT_SEPARATOR = " ";

/** The most pieces a split is asked for, which no text reaches. */
const MAX_PIECES = 2147483647;

const CASE_FUNCTIONS = {
  str_upcase: (text) => sql`UPPER(${text})`,
  str_downcase: (text) => sql`LOWER(${text})`,
} satisfies Record<string, (text: Sql) => Sql>;

function CaseStage(convert: (text: Sql) => Sql): StageHandler {
  return Lift((value, _args, _stage, context) => ({
    sql: convert(TextOf(value, context).sql),
    type: TEXT,
  }));
}

const LengthStage = Lift((value, _args, _stage, context) =>
  AsFloat(context.dialect, sql`CHAR_LENGTH(${TextOf(value, context).sql})`),
);

const ConcatStage = Lift((value, args, stage, context) => {
  const dialect = context.dialect;
  const other = RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND);
  return {
    sql: dialect.sql.scalar.concat([
      TextOf(value, context).sql,
      TextOf(other, context).sql,
    ]),
    type: TEXT,
  };
});

const MatchStage = LiftRaw((value, stage, context) => {
  const dialect = context.dialect;
  const raw = StageOperand(stage, FIRST_OPERAND);
  const pattern = IsString(raw)
    ? TextParam(dialect, dialect.sql.scalar.regex.translate(raw))
    : RequireOperand(
        DecodeOperand(stage, FIRST_OPERAND, context),
        stage,
        FIRST_OPERAND,
      );
  return {
    sql: dialect.sql.scalar.regex.matches(
      TextOf(value, context).sql,
      TextOf(pattern, context).sql,
    ),
    type: BOOL,
  };
});

/** `NaN` names no bound at all, and `Infinity` is every piece. */
function PieceLimit(maxSplits: number | undefined): number | undefined {
  if (maxSplits === undefined || Number.isNaN(maxSplits)) {
    return undefined;
  }
  return Math.min(Math.max(Math.trunc(maxSplits), 0), MAX_PIECES);
}

const SplitStage = LiftRaw((value, stage, context) => {
  const dialect = context.dialect;
  const options: SplitOptions = OptionsOf(stage) ?? {};
  return {
    sql: dialect.sql.json.split(
      TextOf(value, context).sql,
      options.separator ?? DEFAULT_SEPARATOR,
      PieceLimit(options.maxSplits),
      context.nextAlias(),
    ),
    type: ArrayOf(TEXT),
  };
});

/**
 * String stages.
 *
 * Every operand is read through `TextOf`, which for a JSON source is the projection guarded on the
 * value being a JSON string, so a stored number yields NULL rather than its decimal spelling,
 * which keeps a heterogeneous overflow key from comparing equal across types. A timestamp is its
 * ISO 8601 rendering in UTC.
 *
 * - `str_len` counts codepoints, as the contract documents; JavaScript's `String.length` counts
 *   UTF-16 code units, so the two disagree on an astral-plane character.
 * - `str_concat` is `CONCAT`, whose NULL operand makes the whole result NULL. MySQL's `||` is OR
 *   and is never emitted.
 * - `str_match` answers a boolean. A literal pattern is rewritten from JavaScript's flavour into
 *   the engine's by the dialect; a pattern computed from a value is bound as it is.
 * - `str_split` carries its separator and its bound in `stage.options` and takes no arguments,
 *   which is why it is lifted raw. `maxSplits` truncates the result, and an empty text is one
 *   empty piece.
 */
export const STRING_STAGES: StageMap = {
  ...BuildStages(CASE_FUNCTIONS, CaseStage),
  str_len: LengthStage,
  str_concat: ConcatStage,
  str_match: MatchStage,
  str_split: SplitStage,
};
