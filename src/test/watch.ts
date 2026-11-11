import { expect } from "chai";
import type { Changes } from "@antelopejs/interface-database/common";
import type { Table } from "@antelopejs/interface-database/selection";

/** Long enough for the change clock to tick a few times; a delivery never takes this long. */
export const QUIET_MS = 400;

/** A row of the tables the feed tests watch. */
export interface Row {
  _id: string;
  label?: string;
  name?: string;
  size?: number;
  meta?: Record<string, number> | null;
}

export type Feed = ReturnType<ReturnType<Table<Row>["changes"]>["cursor"]>;

export function Pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Whether `pending` settles within `ms`, without consuming what it settles to. */
export async function SettlesWithin(pending: Promise<unknown>, ms: number) {
  const late = Symbol("late");
  const first = await Promise.race([
    pending.then(
      () => true,
      () => true,
    ),
    Pause(ms).then(() => late),
  ]);
  return first !== late;
}

export async function Delivered(
  pending: Promise<IteratorResult<Changes<Row>, void>>,
): Promise<Changes<Row>> {
  const step = await pending;
  if (step.done) {
    expect.fail("the feed delivers an event");
  }
  return step.value;
}

/**
 * Reads the feed until the event of the row `id`, and answers it. Every event before it is the
 * caller's to expect, so a test only skips over its own probes.
 */
export async function DeliveredRow(feed: Feed, id: string) {
  for (;;) {
    const change = await Delivered(feed.next());
    if (change.newValue?._id === id || change.oldValue?._id === id) {
      return change;
    }
  }
}

/**
 * Opens a feed on `table` and answers it once it is known open, with nothing left to deliver.
 *
 * Opening numbers every row already committed, which takes as long as the backlog is, so a probe
 * is inserted until one is delivered; a last probe is then read through, past any earlier probe
 * that committed once the feed was open.
 */
export async function Opened(table: Table<Row>, probe: string): Promise<Feed> {
  const feed = table.changes().cursor();
  const first = feed.next();
  for (let attempt = 0; !(await SettlesWithin(first, QUIET_MS)); attempt += 1) {
    await table.insert({ _id: `${probe}-${attempt}` });
  }
  await Delivered(first);
  const last = `${probe}-open`;
  await table.insert({ _id: last });
  await DeliveredRow(feed, last);
  return feed;
}
