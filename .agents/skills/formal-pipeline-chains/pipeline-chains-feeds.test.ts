import { expect } from "chai";
import fc from "fast-check";

import { Streamed } from "./build";
import { Bounds } from "./bounds";
import { FEED_DRAW, ResolveFeed, Script } from "./draw";
import {
  type Doc,
  Delivered,
  Evaluate,
  type FeedEvent,
  type Stage,
  type Write,
} from "./model";
import { Reader } from "./reader";
import { Fixture, TABLES } from "./seed";

const fixture = Fixture("pipeline_chains_feeds");

/** Longer than the change clock's tick, so an event that is coming has come. */
const QUIET_MS = 300;
const OPEN_ATTEMPTS = 10;
const DELIVERY_MS = 5000;
const KINDS = [undefined, "a", "b", "c"];
const IDS = ["i00", "i01", "i02", "i03", "x00", "x01"];
const NUMBERS = [0, 1, 2, 3, 4];
const OWNERS = [undefined, "o1", "o2", "o3", "o4", "missing"];

/** Every document a write can leave in the table, in the order the probe tries them. */
function Candidates(): Doc[] {
  return IDS.flatMap((_id) =>
    NUMBERS.flatMap((n) =>
      KINDS.flatMap((kind) =>
        OWNERS.map((ownerId) => {
          const doc: Doc = { _id, n, slug: `s-${_id}` };
          if (kind !== undefined) {
            doc.kind = kind;
          }
          if (ownerId !== undefined) {
            doc.ownerId = ownerId;
          }
          return doc;
        }),
      ),
    ),
  );
}

/** A document some write can leave in the table whose image the chain passes, if any. */
function Probe(stages: readonly Stage[]): Doc | undefined {
  return Candidates().find(
    (doc) => Evaluate(stages, [doc], TABLES, undefined).length === 1,
  );
}

async function Cleared(): Promise<void> {
  await fixture.handles.items().delete().run();
}

/**
 * Waits until the feed is open. A feed opens when it is first read, and a write before that is not
 * delivered, so a document the chain passes is written until one is delivered, then deleted, and
 * its removal awaited however late a loaded host delivers it. With no such
 * document no write of the script is delivered either, and a pause is as good.
 */
async function Opened(reader: Reader, stages: readonly Stage[]): Promise<void> {
  const probe = Probe(stages);
  if (!probe) {
    await reader.drain(QUIET_MS);
    return;
  }
  for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt += 1) {
    await fixture.handles.items().insert(probe).run();
    if (await reader.next(QUIET_MS)) {
      await Cleared();
      await reader.next(DELIVERY_MS);
      await reader.drain(QUIET_MS);
      return;
    }
    await Cleared();
  }
  throw new Error(`the feed did not open within ${OPEN_ATTEMPTS} attempts`);
}

async function Written(write: Write): Promise<void> {
  const items = fixture.handles.items();
  if (write.kind === "insert") {
    await items.insert(write.doc).run();
  } else if (write.kind === "update") {
    await items.get(write.id).update(write.changes).run();
  } else {
    await items.get(write.id).delete().run();
  }
}

async function Received(reader: Reader, count: number): Promise<FeedEvent[]> {
  const events: FeedEvent[] = [];
  while (events.length < count) {
    const event = await reader.next(DELIVERY_MS);
    if (!event) {
      break;
    }
    events.push(event);
  }
  events.push(...(await reader.drain(QUIET_MS)));
  return events;
}

/** What a feed over `stages` delivers for the `writes`, beside the events the reference names. */
async function Observed(
  stages: readonly Stage[],
  writes: readonly Write[],
): Promise<{ events: FeedEvent[]; expected: FeedEvent[]; message: string }> {
  const expected = Delivered(stages, writes, TABLES);
  await Cleared();
  const reader = new Reader(
    Streamed(stages, fixture.handles).changes().cursor(),
  );
  try {
    await Opened(reader, stages);
    for (const write of writes) {
      await Written(write);
    }
    const events = await Received(reader, expected.length);
    const message = JSON.stringify({ stages, writes, expected, events });
    return { events, expected, message };
  } finally {
    await reader.close();
  }
}

/**
 * Every engine delivers the events of a feed over drawn stages as the reference does: the same
 * events in the order the writes committed, each with the old and new image the stages make of the
 * row, whether or not the filter lets that image through, and an `added` or `removed` event
 * with one image only.
 *
 * It fails on a feed whose second map reads the row the first one merged (unknown `ev.new_row`,
 * #75), and on one that delivers a null `oldValue` or `newValue` for an update that leaves or enters
 * the filter before two maps (#78).
 */
describe("a change feed over a chain of stages on a real server", function () {
  this.timeout(1_800_000);

  before(() => fixture.seed([]));
  after(() => fixture.unseed());

  it("delivers the events the reference evaluator expects", async () => {
    await fc.assert(
      fc.asyncProperty(FEED_DRAW, async (draw) => {
        const seen = await Observed(ResolveFeed(draw), Script(draw));
        expect(seen.events, seen.message).to.deep.equal(seen.expected);
      }),
      Bounds("FEEDS_RUNS", 30, false),
    );
  });

  it("delivers both images of an update that leaves and enters a filter before two merges", async () => {
    const seen = await Observed(
      [
        { kind: "filter", field: "kind", compare: "eq", value: "a" },
        {
          kind: "merge",
          name: "m",
          expression: { kind: "number", value: 1 },
        },
        {
          kind: "merge",
          name: "o",
          expression: { kind: "text", value: "y" },
        },
      ],
      [
        { kind: "insert", doc: { _id: "i00", n: 1, slug: "s-i00", kind: "a" } },
        { kind: "update", id: "i00", changes: { kind: "b" } },
        { kind: "update", id: "i00", changes: { kind: "a" } },
        { kind: "delete", id: "i00" },
      ],
    );
    expect(seen.events, seen.message).to.deep.equal(seen.expected);
  });
});
