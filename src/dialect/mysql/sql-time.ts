import type { TimePart, TimeSyntax } from "../sql-time-types";
import { type Sql, sql } from "../../statement";
import type { Flavour } from "./flavour";

/** `DATETIME`'s range in epoch milliseconds: 1000-01-01 to the last millisecond of 9999. */
const EARLIEST_EPOCH_MS = sql`-30610224000000`;
const LATEST_EPOCH_MS = sql`253402300799999`;

const EPOCH = sql`CAST('1970-01-01 00:00:00' AS DATETIME(6))`;

/**
 * The spellings of an instant `CAST(... AS DATETIME(6))` reads the way `new Date()` does: a date, or
 * a date and a time with an optional fraction and zone. Anything else is not cast, because a cast
 * that fails inside a statement that writes fails the statement.
 */
const INSTANT_TEXT = sql`'^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?$'`;

/** An instant as `Date.prototype.toISOString` spells it: milliseconds and `Z`, the session being UTC. */
export function IsoText(value: Sql): Sql {
  return sql`CONCAT(LEFT(DATE_FORMAT(${value}, '%Y-%m-%dT%H:%i:%s.%f'), 23), 'Z')`;
}

/** Text read as an instant where it spells one {@link INSTANT_TEXT} accepts, SQL NULL otherwise. */
export function ParseInstant(flavour: Flavour, text: Sql): Sql {
  return sql`(CASE WHEN ${text} REGEXP ${INSTANT_TEXT} THEN ${flavour.instant(text)} END)`;
}

/** Counted from the epoch in microseconds, which reaches before 1970 where `UNIX_TIMESTAMP` answers 0. */
function ToEpochMs(value: Sql): Sql {
  return sql`CAST(TIMESTAMPDIFF(MICROSECOND, ${EPOCH}, ${value}) / 1000 AS DOUBLE)`;
}

function FromEpochMs(value: Sql): Sql {
  return sql`(CASE WHEN ${value} BETWEEN ${EARLIEST_EPOCH_MS} AND ${LATEST_EPOCH_MS} THEN TIMESTAMPADD(MICROSECOND, ${value} * 1000, ${EPOCH}) END)`;
}

const MICROSECONDS_PER_SECOND = sql`1000000`;

/**
 * Every reading is of the instant as the session holds it, which is UTC. `second` is the seconds
 * and microseconds the server reads together, so the operand is spelled once.
 */
const PARTS: Record<TimePart, (moment: Sql) => Sql> = {
  year: (moment) => sql`YEAR(${moment})`,
  month: (moment) => sql`MONTH(${moment})`,
  day: (moment) => sql`DAYOFMONTH(${moment})`,
  weekday: (moment) => sql`(WEEKDAY(${moment}) + 1)`,
  dayOfYear: (moment) => sql`DAYOFYEAR(${moment})`,
  hour: (moment) => sql`HOUR(${moment})`,
  minute: (moment) => sql`MINUTE(${moment})`,
  second: (moment) =>
    sql`(EXTRACT(SECOND_MICROSECOND FROM ${moment}) / ${MICROSECONDS_PER_SECOND})`,
  timeOfDay: (moment) =>
    sql`(TIME_TO_SEC(TIME(DATE_FORMAT(${moment}, '%H:%i:%s'))) + MICROSECOND(${moment}) / ${MICROSECONDS_PER_SECOND})`,
};

export function TimeOf(flavour: Flavour): TimeSyntax {
  return {
    part: (moment, part) => PARTS[part](moment),
    inZone: (moment, zone) => sql`CONVERT_TZ(${moment}, '+00:00', ${zone})`,
    isoText: IsoText,
    toEpochMs: ToEpochMs,
    fromEpochMs: FromEpochMs,
    parseText: (text) => ParseInstant(flavour, text),
  };
}
