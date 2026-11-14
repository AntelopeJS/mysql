import type { QueryStage } from "@antelopejs/interface-database/common";

import type { TimePart } from "../../dialect/sql-time-types";
import { sql } from "../../statement";
import { BOOL } from "./types";
import { AsFloat, MILLISECONDS_PER_SECOND, Moment } from "./readings";
import {
  AsValue,
  BuildStages,
  FIRST_OPERAND,
  Lift,
  RequireOperand,
  SECOND_OPERAND,
  type StageHandler,
  type StageMap,
} from "./stage";
import { IsString } from "./guards";

const DATE_PARTS = {
  date_year: "year",
  date_month: "month",
  date_day: "day",
  date_dow: "weekday",
  date_doy: "dayOfYear",
  date_hours: "hour",
  date_minutes: "minute",
  date_seconds: "second",
} as const satisfies Record<string, TimePart>;

/**
 * Reads one part of an instant, in the zone a preceding `date_with_timezone` named or in UTC. The
 * session is UTC, so no reading depends on the connection's settings.
 */
function LocalStage(part: TimePart): StageHandler {
  return (state, _stage, context) => {
    const dialect = context.dialect;
    const moment = Moment(dialect, AsValue(state)).sql;
    const local =
      state.timezone === undefined
        ? moment
        : dialect.sql.time.inZone(
            moment,
            dialect.sql.scalar.bind.text(state.timezone),
          );
    return { current: AsFloat(dialect, dialect.sql.time.part(local, part)) };
  };
}

function ZoneName(stage: QueryStage): string {
  const zone: unknown = stage.args[FIRST_OPERAND];
  if (!IsString(zone) || zone.length === 0) {
    throw new Error(
      `Stage '${stage.stage}' requires a time zone name at position ${FIRST_OPERAND}`,
    );
  }
  return zone;
}

const TimezoneStage: StageHandler = (state, stage) => ({
  current: state.current,
  timezone: ZoneName(stage),
});

const EpochStage = Lift((value, _args, _stage, context) => {
  const dialect = context.dialect;
  const milliseconds = dialect.sql.time.toEpochMs(Moment(dialect, value).sql);
  return AsFloat(dialect, sql`(${milliseconds} / ${MILLISECONDS_PER_SECOND})`);
});

const DuringStage = Lift((value, args, stage, context) => {
  const dialect = context.dialect;
  const moment = Moment(dialect, value).sql;
  const low = Moment(
    dialect,
    RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND),
  ).sql;
  const high = Moment(
    dialect,
    RequireOperand(args[SECOND_OPERAND], stage, SECOND_OPERAND),
  ).sql;
  return {
    sql: sql`((${moment} >= ${low}) AND (${moment} < ${high}))`,
    type: BOOL,
  };
});

/**
 * Date stages.
 *
 * No extraction reads an instant under session state: the session is UTC, and an extraction in
 * another zone converts the instant first, through the dialect. A zone the server does not know
 * reads as SQL NULL, where PostgreSQL fails the statement. The named zones need the server's
 * time zone tables, which the official images load.
 *
 * The zone is *state*, not a transformation: `date_with_timezone` records it on the accumulator
 * and passes the accumulator through untouched, so a row addressing a column keeps the column's
 * index for a stage that never reads the value. Only the date parts that follow consume it; every
 * other stage drops it, because `Lift` and `LiftRaw` return a state without one. `date_epoch` and
 * `date_during` are lifted for that reason: an instant and a comparison between instants do not
 * depend on a zone. `during` is low-inclusive and high-exclusive, as the contract documents.
 *
 * `date_dow` runs from Monday 1 to Sunday 7, which is the range the contract's callers assert.
 * `date_seconds` and `date_tod` carry the fractional second, as ReQL does: `30.25` where
 * JavaScript's `getSeconds` would say `30`.
 */
export const DATE_STAGES: StageMap = {
  date_with_timezone: TimezoneStage,
  date_epoch: EpochStage,
  date_during: DuringStage,
  date_tod: LocalStage("timeOfDay"),
  ...BuildStages(DATE_PARTS, LocalStage),
};
