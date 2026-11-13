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
  FieldNames,
  FieldOf,
  RequireOperand,
} from "./stage";
import { CurrentValue, SetPlainProjection, SetProjection } from "./relation";
import type { RelationFlag } from "./render";
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

/** The stages that keep fewer of the rows they read, so a mapper before them runs on fewer rows. */
const BOUNDING_STAGES: ReadonlySet<string> = new Set(["slice", "nth"]);

/**
 * Applies the mapper to each row, binding the relation's own source as its parameter, which keeps
 * `map(d => d.key("name"))` a bare column. The parameter ranges over every row of the relation only
 * where no later stage bounds the rows the mapper runs on.
 */
const MapStage: PipelineStage = (relation, stage, context, later) => {
  const prepared = Prepare(relation, PROJECTION_BLOCKERS, context);
  const bounded = later.some((next) => BOUNDING_STAGES.has(next.stage));
  const body = DecodeFunction(
    RecordedLambda(stage, FIRST_OPERAND),
    context,
    [prepared.source],
    bounded ? undefined : prepared,
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
};
