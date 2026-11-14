import type { QueryStage } from "@antelopejs/interface-database/common";

import type { Dialect } from "../../dialect";
import { type Sql, join, sql } from "../../statement";
import { SplitWrite } from "./writes";
import { AsJson } from "./readings";
import { CHANGE_LOG } from "./registry";
import { DecodingContext } from "./context";
import { CompileSubquery } from "./subquery";
import { QualifiedColumn } from "./sql";
import { CompileExpression } from "./expression";
import { BOOL, OPAQUE, type SqlType } from "./types";
import { ApplyStages, CompileRelation, IsPipelineStage } from "./pipeline";
import {
  CurrentValue,
  LoggedRelation,
  type Relation,
  type TableOrigin,
} from "./relation";
import { Render } from "./render";

/** The alias the poll reads a log row at, which both sides read its images through. */
export const EVENT_ALIAS = "ev";

/**
 * The alias each side's one row is read through, fixed rather than taken from the context.
 * Each side renders into its own subselect, so the name cannot collide outside it.
 */
const SIDE_ALIAS = "s";

const DOC_KEY = "doc";
const MATCHED_KEY = "matched";

const MATCHES_EVERYTHING = sql`TRUE`;

/** Whether a stage decides which rows pass, or what a passing row delivers. */
type FeedStageRole = "selects" | "projects";

/**
 * The stages a feed accepts before `changes()`, chosen by meaning rather than by what compiles.
 * `get` is the predicate alone here, and a `lookup` resolves as of delivery, not as of the event.
 */
const FEED_STAGES: ReadonlyMap<string, FeedStageRole> = new Map([
  ["filter", "selects"],
  ["map", "projects"],
  ["pluck", "projects"],
  ["without", "projects"],
  ["key", "projects"],
  ["default", "projects"],
  ["get", "selects"],
  ["getAll", "selects"],
  ["between", "selects"],
  ["lookup", "projects"],
]);

/**
 * What the stages compile to, one statement per side of an event. Each answers one row whose one
 * column is `{doc, matched}`: what the side projects, and whether it passed the stages' predicates.
 * `matches` answers `matched` alone, without building the document.
 */
export interface FeedPlan {
  readonly old: Sql;
  readonly new: Sql;
  readonly matches: { readonly old: Sql; readonly new: Sql };
  readonly type: SqlType;
}

function IsKnownStage(stage: QueryStage): boolean {
  return (
    IsPipelineStage(stage.stage) || SplitWrite([stage]).write !== undefined
  );
}

/**
 * Refuses a stage a feed cannot answer, naming the position as well as the stage.
 * Every stage refused here is legal one level out, so naming only the stage would mislead.
 */
function RefuseStage(stage: QueryStage): never {
  if (IsKnownStage(stage)) {
    throw new Error(
      `The '${stage.stage}' stage cannot be used before 'changes': it needs a total order or a finite relation, and a change feed is neither`,
    );
  }
  throw new Error(`Unsupported query stage '${stage.stage}'`);
}

function Accepted(stages: QueryStage[]): QueryStage[] {
  for (const stage of stages) {
    if (!FEED_STAGES.has(stage.stage)) {
      RefuseStage(stage);
    }
  }
  return stages;
}

/** The admission test for one side: every predicate the stages absorbed, or nothing to test. */
function Matches(where: readonly Sql[]): Sql {
  return where.length > 0 ? join(where, sql` AND `) : MATCHES_EVERYTHING;
}

/**
 * One side's select list: the document `projected` delivers beside whether `matched` passed, as
 * the text of one JSON object, so a document nested to the engine's depth limit is still delivered.
 * `matched` is its own statement, since a stage that wraps the filtered side keeps its predicates
 * inside the wrap and answers no row, rather than a false one, for a side that fails them.
 */
function Side(projected: Relation, matched: Sql): Relation {
  const { json } = projected.dialect.sql;
  const document = AsJson(projected.dialect, CurrentValue(projected));
  const passed = json.of(sql`COALESCE((${matched}), FALSE)`, "bool");
  return {
    ...projected,
    projection: {
      sql: json.objectText([
        [DOC_KEY, document.sql],
        [MATCHED_KEY, passed],
      ]),
      type: OPAQUE,
    },
  };
}

/** Whether the side passed the stages' predicates, as a SQL boolean over its one row or none. */
function Match(folded: Relation): Relation {
  return {
    ...folded,
    where: [],
    projection: { sql: Matches(folded.where), type: BOOL },
  };
}

/** The stages that build what a side delivers, which no predicate changes. */
function Projecting(stages: QueryStage[]): QueryStage[] {
  return stages.filter((stage) => FEED_STAGES.get(stage.stage) === "projects");
}

/**
 * Compiles the stages against one side's row, with the `from` real from the start.
 * A stage that wraps renders its input into its own `from`, where no later substitution reaches.
 */
function CompileSide(
  stages: QueryStage[],
  origin: TableOrigin,
  context: DecodingContext,
  image: string,
): Relation {
  const { from, value } = context.dialect.sql.rows.hold(
    QualifiedColumn(EVENT_ALIAS, image),
    SIDE_ALIAS,
  );
  const relation = LoggedRelation(
    context.dialect,
    from,
    SIDE_ALIAS,
    value,
    origin,
  );
  return ApplyStages(relation, stages, context);
}

/**
 * Compiles the stages against each side of a logged event.
 *
 * **The relation-per-side is the mechanism rather than an economy.** Sourcing the stages directly
 * off the log's two columns looks simpler and breaks immediately: `filter` absorbs into the
 * relation's `WHERE`, and deciding "matched before **or** matches now" needs that predicate as a
 * boolean value. So each side is an ordinary relation over one row, folded by the ordinary fold.
 *
 * The predicate is evaluated **independently on both sides** and the caller admits the event if
 * either matched. Testing one document instead, the new one where there is one, silently drops
 * every event where a row *leaves* the filter, because an update always has a new row to prefer.
 *
 * The documents follow the **operation**, not the membership: an update carries both sides even
 * where one of them no longer matches, which is what lets a consumer see what a row looked like
 * before it left the filter. So each document is compiled from the projecting stages alone, over
 * a relation that keeps its one row whatever a later stage wraps.
 */
export function CompileFeed(
  stages: QueryStage[],
  origin: TableOrigin,
  dialect: Dialect,
): FeedPlan {
  const context = new DecodingContext(
    {
      expression: CompileExpression,
      subquery: CompileSubquery,
      relation: CompileRelation,
    },
    dialect,
  );
  const accepted = Accepted(stages);
  const projecting = Projecting(accepted);
  const [before, after] = [CHANGE_LOG.oldImage, CHANGE_LOG.newImage].map(
    (image) => {
      const matched = Render(
        Match(CompileSide(accepted, origin, context, image)),
      );
      const projected = CompileSide(projecting, origin, context, image);
      return { matched, projected };
    },
  );
  return {
    old: Render(Side(before.projected, before.matched)),
    new: Render(Side(after.projected, after.matched)),
    matches: { old: before.matched, new: after.matched },
    type: CurrentValue(before.projected).type,
  };
}
