import type { TimeSyntax } from "../sql-types";
import { type Sql, sql } from "../../statement";

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

/**
 * Text read as an instant where it spells one {@link INSTANT_TEXT} accepts, SQL NULL otherwise. The
 * server reads a zone offset but not `Z`, which can only end the text, so it is spelled as one.
 */
export function ParseInstant(text: Sql): Sql {
  return sql`(CASE WHEN ${text} REGEXP ${INSTANT_TEXT} THEN CAST(REPLACE(${text}, 'Z', '+00:00') AS DATETIME(6)) END)`;
}

/** Counted from the epoch in microseconds, which reaches before 1970 where `UNIX_TIMESTAMP` answers 0. */
function ToEpochMs(value: Sql): Sql {
  return sql`CAST(TIMESTAMPDIFF(MICROSECOND, ${EPOCH}, ${value}) / 1000 AS DOUBLE)`;
}

function FromEpochMs(value: Sql): Sql {
  return sql`(CASE WHEN ${value} BETWEEN ${EARLIEST_EPOCH_MS} AND ${LATEST_EPOCH_MS} THEN TIMESTAMPADD(MICROSECOND, ${value} * 1000, ${EPOCH}) END)`;
}

export const time: TimeSyntax = {
  isoText: IsoText,
  toEpochMs: ToEpochMs,
  fromEpochMs: FromEpochMs,
  parseText: ParseInstant,
};
