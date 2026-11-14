import type { Sql } from "../statement";

/** The calendar and clock readings of an instant. */
export type TimePart =
  | "year"
  | "month"
  | "day"
  | "weekday"
  | "dayOfYear"
  | "hour"
  | "minute"
  | "second"
  | "timeOfDay";

/** Instants: stored in UTC, read and written in JavaScript's spellings. */
export interface TimeSyntax {
  /**
   * A reading of an instant as a number: the weekday runs from Monday 1 to Sunday 7, and `second`
   * and `timeOfDay` (in seconds since midnight) carry the fraction.
   */
  part(moment: Sql, part: TimePart): Sql;
  /** The wall-clock reading of an instant in a named or offset zone; SQL NULL for a zone the engine does not know. */
  inZone(moment: Sql, zone: Sql): Sql;
  /** An instant as `Date.prototype.toISOString` spells it. */
  isoText(value: Sql): Sql;
  /** An instant as epoch milliseconds. */
  toEpochMs(value: Sql): Sql;
  /** Epoch milliseconds as an instant; SQL NULL outside the range an instant can hold. */
  fromEpochMs(value: Sql): Sql;
  /** Text read as an instant where it spells an ISO 8601 date or date-time, SQL NULL otherwise. */
  parseText(text: Sql): Sql;
}
