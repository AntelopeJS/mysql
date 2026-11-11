import { join, sql } from "../../statement";
import type { WalkKind } from "../../dialect/sql-types";
import { AsJson } from "./readings";
import { Collected } from "./json";
import { GuardJson } from "./json-guard";
import {
  ArrayOf,
  BOOL,
  MergeKeyTypes,
  OPAQUE,
  type SqlType,
  TEXT,
} from "./types";
import {
  BuildStages,
  FIRST_OPERAND,
  FieldNames,
  Lift,
  LiftRaw,
  RequireOperand,
  type StageHandler,
  type StageMap,
} from "./stage";

interface ObjectWalk {
  kind: WalkKind;
  elem: SqlType;
}

const MergeStage = Lift((value, args, stage, context) => {
  const dialect = context.dialect;
  const other = RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND);
  return {
    sql: dialect.sql.json.shallowMerge(
      AsJson(dialect, value).sql,
      AsJson(dialect, other).sql,
      context.nextAlias(),
    ),
    type: MergeKeyTypes(value.type, other.type),
  };
});

const WALKS = {
  obj_keys: { kind: "keys", elem: TEXT },
  obj_values: { kind: "members", elem: OPAQUE },
} satisfies Record<string, ObjectWalk>;

function WalkStage(walked: ObjectWalk): StageHandler {
  return LiftRaw((value, _stage, context) => {
    const dialect = context.dialect;
    const json = AsJson(dialect, value);
    const walk = dialect.sql.json.walk(
      walked.kind,
      json.sql,
      context.nextAlias(),
    );
    const collected = Collected(dialect, walk.ordinal, walk.value);
    return {
      sql: GuardJson(dialect, json, "object", walk.aggregate(collected)),
      type: ArrayOf(walked.elem),
    };
  });
}

const HasStage = LiftRaw((value, stage, context) => {
  const dialect = context.dialect;
  const json = dialect.sql.json;
  const document = AsJson(dialect, value).sql;
  const present = FieldNames(stage).map((key) => json.hasKey(document, key));
  return {
    sql:
      present.length === 0
        ? json.is(document, ["object"])
        : sql`(${join(present, sql` AND `)})`,
    type: BOOL,
  };
});

/**
 * Object stages. `obj_index` is in the core module, because basic filters need it.
 *
 * - `obj_merge` is one level deep, unlike ReQL's recursive `merge`, with the right's members
 *   winning and any null kept. It answers NULL for an operand that is not an object. The *type*
 *   merges as `{...left, ...right}`, so a date surviving a merge still decodes as a `Date`.
 * - `obj_keys` and `obj_values` walk the object in the server's own order of it, which is the same
 *   for both, so `keys()` and `values()` line up element for element. Both answer `[]` for an
 *   empty object.
 * - `obj_has` reads its argument as a list of literal keys, not as a value. A non-object answers
 *   `false`, a key whose value is a JSON null counts as present, and an empty list is true of an
 *   object and false of anything else.
 */
export const OBJECT_STAGES: StageMap = {
  obj_merge: MergeStage,
  ...BuildStages(WALKS, WalkStage),
  obj_has: HasStage,
};
