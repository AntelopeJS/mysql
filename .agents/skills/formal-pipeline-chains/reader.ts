import type { Changes } from "@antelopejs/interface-database/common";

import type { Doc, FeedEvent } from "./model";

const LATE = Symbol("late");

function Pause(ms: number): Promise<typeof LATE> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(LATE), ms);
  });
}

type Feed = AsyncGenerator<Changes<Doc>, void, unknown>;

/** What a feed delivered, as a plain event: a side the feed did not send is a key it lacks. */
function Plain(change: Changes<Doc>): FeedEvent {
  const { changeType, oldValue, newValue } = change;
  if (oldValue !== undefined && newValue !== undefined) {
    return { changeType, oldValue, newValue };
  }
  if (oldValue !== undefined) {
    return { changeType, oldValue };
  }
  if (newValue !== undefined) {
    return { changeType, newValue };
  }
  return { changeType };
}

/**
 * Reads a feed with a time limit on each event. An event that is late stays awaited, so the next
 * read takes it and no delivery is lost between two reads.
 */
export class Reader {
  private waiting: Promise<IteratorResult<Changes<Doc>, void>> | undefined;

  constructor(private readonly feed: Feed) {}

  /** The next event, or `undefined` when none comes within `ms`. */
  async next(ms: number): Promise<FeedEvent | undefined> {
    this.waiting ??= this.feed.next();
    const step = await Promise.race([this.waiting, Pause(ms)]);
    if (step === LATE) {
      return undefined;
    }
    this.waiting = undefined;
    if (step.done) {
      throw new Error("the feed ended");
    }
    return Plain(step.value);
  }

  /** Reads until `ms` pass with nothing delivered, and answers what was read. */
  async drain(ms: number): Promise<FeedEvent[]> {
    const events: FeedEvent[] = [];
    for (let event = await this.next(ms); event; event = await this.next(ms)) {
      events.push(event);
    }
    return events;
  }

  async close(): Promise<void> {
    await this.feed.return?.();
  }
}
