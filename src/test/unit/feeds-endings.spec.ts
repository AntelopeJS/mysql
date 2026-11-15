import assert from "node:assert";
import { expect } from "chai";

import { CloseCursor, ReadCursor } from "../../implementations/database/query";
import {
  CloseAllFeeds,
  CloseOneFeed,
  type FeedEnvironment,
  IsRegisteredFeed,
} from "../../implementations/database/feeds";
import {
  Feed,
  LATER_EPOCH,
  Matched,
  NewReqId,
  Reader,
  SCHEMA_ID,
  Settled,
  Stages,
  Step,
  TABLE_ID,
  WhileConfigured,
} from "./feeds-fixture";

/** How long a woken feed may take to deliver: far below its fallback wait of seconds. */
const WOKEN_WITHIN_MS = 500;

async function Rejection(pending: Promise<unknown>): Promise<string> {
  return pending.then(
    () => expect.fail("the feed must not continue"),
    (err: unknown) => {
      assert(err instanceof Error, "the feed rejects with an Error");
      return err.message;
    },
  );
}

describe("the ways a change feed ends", () => {
  it("rejects when its watermark is below what the reaper deleted from its table, naming the range", async () => {
    const { env } = Reader([{ highWater: 9 }], 5);
    const message = await Feed((reqId) => Rejection(Step(reqId, env)));
    expect(message).to.contain("changeRetentionMs");
    expect(message).to.contain("events 6 through 9");
    expect(message).to.contain(`${SCHEMA_ID}.${TABLE_ID}`);
  });

  /**
   * A driver that leaves the state of a failed open live opens the feed again on the next read, and
   * keeps the state in its registry with no ending to evict it by.
   */
  it("releases a feed whose open rejected, so a later read answers an empty batch without opening again", async () => {
    const { env } = Reader([{}]);
    let opens = 0;
    const failing: FeedEnvironment = {
      ...env,
      open: () => {
        opens += 1;
        return Promise.reject(new Error("the log cannot be read"));
      },
    };
    const reqId = NewReqId();
    const message = await WhileConfigured(() =>
      Rejection(Step(reqId, failing)),
    );
    expect(message).to.equal("the log cannot be read");
    expect(await WhileConfigured(() => Step(reqId, failing))).to.deep.equal([]);
    expect(opens).to.equal(1);
  });

  it("does not reject on a high-water it is still at", async () => {
    const { env } = Reader(
      [
        {
          highWater: 9,
          events: [{ seq: 10, op: "added", new: Matched({ _id: "a" }) }],
        },
      ],
      9,
    );
    const events = await Feed((reqId) => Step(reqId, env));
    expect(events).to.have.length(1);
  });

  it("rejects when the log was recreated under it, since its events went with the old one", async () => {
    const { env } = Reader([{ epoch: LATER_EPOCH }], 5);
    const message = await Feed((reqId) => Rejection(Step(reqId, env)));
    expect(message).to.contain("recreated");
    expect(message).to.contain(`${SCHEMA_ID}.${TABLE_ID}`);
  });

  it("answers an empty batch rather than rejecting when it was closed, and stops its wakes", async () => {
    const { env, unsubscribed } = Reader([{}]);
    const reqId = NewReqId();
    const pending = WhileConfigured(() => Step(reqId, env));
    await Settled(pending);
    await CloseOneFeed(reqId);
    expect(await pending).to.deep.equal([]);
    expect(unsubscribed()).to.equal(1);
  });

  it("resolves a waiting read when the connection is being torn down", async () => {
    const { env } = Reader([{}]);
    const reqId = NewReqId();
    const pending = WhileConfigured(() => Step(reqId, env));
    await Settled(pending);
    await CloseAllFeeds();
    expect(await pending).to.deep.equal([]);
  });
});

describe("waking a change feed", () => {
  it("reads the log again as soon as the change clock wakes it", async () => {
    const { env, wakes } = Reader([
      {},
      { events: [{ seq: 1, op: "added", new: Matched({ _id: "a" }) }] },
    ]);
    await Feed(async (reqId) => {
      const pending = Step(reqId, env);
      await Settled(pending);
      expect(wakes).to.have.length(1);
      const started = Date.now();
      wakes[0]();
      const events = await pending;
      expect(events).to.have.length(1);
      expect(events[0]).to.have.nested.property("newValue._id", "a");
      expect(Date.now() - started).to.be.lessThan(WOKEN_WITHIN_MS);
    });
  });

  it("keeps a wake that lands while it polls, rather than sleeping through it", async () => {
    const reader = Reader([
      { events: [{ seq: 1, op: "added", new: Matched({ _id: "a" }) }] },
      {},
      { events: [{ seq: 2, op: "added", new: Matched({ _id: "b" }) }] },
    ]);
    const env: FeedEnvironment = {
      ...reader.env,
      read: (statement) => {
        const rows = reader.env.read(statement);
        if (reader.asked.length === 2) {
          reader.wakes[0]();
        }
        return rows;
      },
    };
    await Feed(async (reqId) => {
      await Step(reqId, env);
      const started = Date.now();
      const second = await Step(reqId, env);
      expect(second).to.have.length(1);
      expect(second[0]).to.have.nested.property("newValue._id", "b");
      expect(Date.now() - started).to.be.lessThan(WOKEN_WITHIN_MS);
    });
  });
});

describe("the change feed registry", () => {
  it("knows a reqId only once it has been read", async () => {
    const reqId = NewReqId();
    expect(IsRegisteredFeed(reqId)).to.equal(false);
    const { env } = Reader([{}]);
    const pending = WhileConfigured(() => Step(reqId, env));
    expect(IsRegisteredFeed(reqId)).to.equal(true);
    await CloseOneFeed(reqId);
    await pending;
  });

  it("closes a reqId it has never seen, so a read arriving after it answers an empty batch", async () => {
    const reqId = NewReqId();
    await CloseOneFeed(reqId);
    const { env } = Reader([{}]);
    expect(await WhileConfigured(() => Step(reqId, env))).to.deep.equal([]);
  });
});

describe("dispatching an iteration between a cursor and a feed", () => {
  it("routes a query ending in 'changes' to the feed registry", async () => {
    const reqId = NewReqId();
    const pending = WhileConfigured(() =>
      ReadCursor(reqId, Stages("default")).then(
        () => undefined,
        () => undefined,
      ),
    );
    expect(IsRegisteredFeed(reqId)).to.equal(true);
    await CloseOneFeed(reqId);
    await pending;
  });

  it("leaves a query that does not end in 'changes' to the cursor path", async () => {
    const reqId = NewReqId();
    await WhileConfigured(() =>
      ReadCursor(reqId, Stages("default").slice(0, -1)).then(
        () => undefined,
        () => undefined,
      ),
    );
    expect(IsRegisteredFeed(reqId)).to.equal(false);
    await CloseCursor(reqId);
  });

  it("closes a feed through the one entry point both kinds share", async () => {
    const { env } = Reader([{}]);
    const reqId = NewReqId();
    const opened = WhileConfigured(() => Step(reqId, env));
    await CloseCursor(reqId);
    expect(await opened).to.deep.equal([]);
    expect(await WhileConfigured(() => Step(reqId, env))).to.deep.equal([]);
  });
});
