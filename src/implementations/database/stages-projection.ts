import { sql } from "../../statement";
import type { Dialect } from "../../dialect";
import { AsJson } from "./readings";
import { WithDefault } from "./coerce";
import type { Compiled } from "./sql";
import { JsonOf, OPAQUE, KeyTypesOf, type SqlType } from "./types";
import { DecodeFunction, NullJson, RecordedLambda } from "./value";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import { BuildDocument, type DocumentMember } from "./row-source";
import {
  DecodeOperand,
  FIRST_OPERAND,
  SECOND_OPERAND,
  FieldNames,
  FieldOf,
  RequireOperand,
} from "./stage";
import type { QueryStage } from "@antelopejs/interface-database/common";

import {
  CurrentValue,
  type Relation,
  SetPlainProjection,
  SetProjection,
} from "./relation";
import { type RelationFlag, SINGLE_ROW } from "./render";
import { ClassifyMember, StageOperand } from "./member";
import { ConstantCount } from "./stages-rows";
import { Prepare } from "./wrap";

/**
 * Every projection stage is blocked by a pending projection and by nothing else: inlining one into
 * the next would square the text, and these reshape rows without selecting them.
 */
const PROJECTION_BLOCKERS: readonly RelationFlag[] = ["projection"];

const KeyStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, PROJECTION_BLOCKERS, context);
  return SetProjection(prepared, FieldOf(prepared.source, stage, context));
};

const DefaultStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, PROJECTION_BLOCKERS, context);
  const def =
    DecodeOperand(stage, FIRST_OPERAND, context) ?? NullJson(context.dialect);
  return SetProjection(
    prepared,
    WithDefault(context.dialect, CurrentValue(prepared), def),
  );
};

/** The rows a relation answers, from the first it reads past `offset`, `limit` of them where set. */
interface RowWindow {
  readonly offset: number;
  readonly limit?: number;
}

/** The rows of `window` that a bound of `offset` and `limit` keeps. */
function Within(window: RowWindow, offset: number, limit?: number): RowWindow {
  const left =
    window.limit === undefined ? undefined : Math.max(0, window.limit - offset);
  const kept = [left, limit].filter((count) => count !== undefined);
  return {
    offset: Math.min(window.offset + offset, Number.MAX_SAFE_INTEGER),
    limit: kept.length > 0 ? Math.min(...kept) : undefined,
  };
}

/** A later stage's row bound written as a number, `null` where the statement computes it. */
function LaterBound(
  stage: QueryStage,
  index: number,
): number | undefined | null {
  if (stage.args[index] === undefined) {
    return undefined;
  }
  const member = ClassifyMember(StageOperand(stage, index));
  return member.kind === "number" ? ConstantCount(member.value) : null;
}

/** The stages that reshape each row and read no other, so a bound after them bounds a map before. */
const PROJECTIONS = ["key", "default", "map", "pluck", "without"] as const;

/**
 * The rows the mapper runs on: the relation, within the bounds of each later `slice` and `nth`
 * that only {@link PROJECTIONS} separate from it, which keep fewer of them. Any other stage reads
 * every mapped row, so a bound after it bounds none of them. None where a bound that does is one
 * the statement computes, and none for bounded rows that read the row of a query outside, which
 * MariaDB reads only through a derived table that cannot read it.
 */
function MappedRows(
  relation: Relation,
  later: readonly QueryStage[],
  readsOuterRow: boolean,
): Relation | undefined {
  let window: RowWindow = {
    offset: relation.offset ?? 0,
    limit: relation.limit,
  };
  const projections: ReadonlySet<string> = new Set(PROJECTIONS);
  for (const next of later) {
    if (projections.has(next.stage)) {
      continue;
    }
    if (next.stage !== "slice" && next.stage !== "nth") {
      break;
    }
    const offset = LaterBound(next, FIRST_OPERAND);
    const limit =
      next.stage === "nth" ? SINGLE_ROW : LaterBound(next, SECOND_OPERAND);
    if (offset === null || limit === null) {
      return undefined;
    }
    window = Within(window, offset ?? 0, limit);
  }
  const bounded = window.offset > 0 || window.limit !== undefined;
  if (bounded && readsOuterRow) {
    return undefined;
  }
  return {
    ...relation,
    offset: window.offset > 0 ? window.offset : undefined,
    limit: window.limit,
  };
}

/**
 * Applies the mapper to each row, binding the relation's own source as its parameter, which keeps
 * `map(d => d.key("name"))` a bare column. The parameter ranges over the rows {@link MappedRows}
 * answers.
 */
const MapStage: PipelineStage = (relation, stage, context, later) => {
  const prepared = Prepare(relation, PROJECTION_BLOCKERS, context);
  const body = DecodeFunction(
    RecordedLambda(stage, FIRST_OPERAND),
    context,
    [prepared.source],
    MappedRows(prepared, later, context.readsOuterRow),
  );
  return SetProjection(prepared, RequireOperand(body, stage, FIRST_OPERAND));
};

/** Builds a document from the named fields alone; `_id` is present only if it was asked for. */
const PluckStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, PROJECTION_BLOCKERS, context);
  const source = prepared.source;
  const members = FieldNames(stage).map((name): DocumentMember => ({
    name,
    ...source.field(name),
  }));
  return SetPlainProjection(
    prepared,
    BuildDocument(context.dialect, members),
    source,
  );
};

function RemainingType(type: SqlType, removed: readonly string[]): SqlType {
  const keyTypes = KeyTypesOf(type);
  if (!keyTypes) {
    return OPAQUE;
  }
  const kept = Object.entries(keyTypes).filter(
    ([name]) => !removed.includes(name),
  );
  return JsonOf(Object.fromEntries(kept));
}

/** Removes the named keys from a document; anything that is not one reads as NULL. */
function Remaining(
  dialect: Dialect,
  value: Compiled,
  removed: readonly string[],
): Compiled {
  const json = dialect.sql.json;
  const document = AsJson(dialect, value).sql;
  return {
    sql: sql`(CASE WHEN ${json.is(document, ["object"])} THEN ${json.removeKeys(document, removed)} END)`,
    type: RemainingType(value.type, removed),
  };
}

const WithoutStage: PipelineStage = (relation, stage, context) => {
  const prepared = Prepare(relation, PROJECTION_BLOCKERS, context);
  return SetProjection(
    prepared,
    Remaining(context.dialect, CurrentValue(prepared), FieldNames(stage)),
  );
};

/** The stages that reshape what each row yields, moving the relation into value mode. */
export const PROJECTION_STAGES: PipelineStageMap = {
  key: KeyStage,
  default: DefaultStage,
  map: MapStage,
  pluck: PluckStage,
  without: WithoutStage,
} satisfies Record<(typeof PROJECTIONS)[number], PipelineStage>;
