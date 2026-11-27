import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";
import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";

import { GetOptions } from "../../config";
import { ReadFeedEvents } from "../../implementations/database/feeds";
import type { RowObject } from "../../implementations/database/result";
import {
  After,
  type Answer,
  Feed,
  Matched,
  Reader,
  Refused,
  Settled,
  Stages,
  Step,
} from "./feeds-fixture";

const ABSENT = undefined;

describe("a change feed's refusals", () => {
  it("refuses a stage that needs an order, naming the stage and the position", async () => {
    const message = await Refused([QueryStage("orderBy", { index: "at" })]);
    expect(message).to.contain("'orderBy'");
    expect(message).to.contain("'changes'");
  });

  it("refuses a stage that needs a finite relation, for the reason it names", async () => {
    const message = await Refused([QueryStage("count", {})]);
    expect(message).to.contain("'count'");
    expect(message).to.contain("total order or a finite relation");
  });

  it("refuses a terminal write before a feed, which is legal one level out", async () => {
    const message = await Refused([QueryStage("insert", undefined, {})]);
    expect(message).to.contain("'insert'");
    expect(message).to.contain("'changes'");
  });

  it("names the first unsupported stage rather than the last", async () => {
    const message = await Refused([
      QueryStage("orderBy", { index: "at" }),
      QueryStage("slice", undefined, 0),
    ]);
    expect(message).to.contain("'orderBy'");
    expect(message).to.not.contain("'slice'");
  });
});

describe("a change feed's watermark", () => {
  it("opens at the log's frontier, so it delivers only what happens next", async () => {
    const { env, asked } = Reader([{}], 42);
    await Feed(async (reqId) => {
      await Settled(Step(reqId, env));
      expect(After(asked[0])).to.equal("42");
    });
  });

  it("moves to the frontier its poll read when the batch was not full, so a quiet table keeps up with the log", async () => {
    const { env, asked } = Reader(
      [
        {
          frontier: 17,
          events: [{ seq: 11, op: "added", new: Matched({ _id: "a" }) }],
        },
        {},
      ],
      10,
    );
    await Feed(async (reqId) => {
      await Step(reqId, env);
      await Settled(Step(reqId, env));
      expect(After(asked[1])).to.equal("17");
    });
  });

  it("moves only to the last row it scanned when the batch was full", async () => {
    await Feed(async (reqId) => {
      const limit = GetOptions().changeBatchSize;
      const events = Array.from({ length: limit }, (_, index) => ({
        seq: index + 1,
        op: "added",
        new: Matched({ _id: String(index) }, false),
      }));
      const { env, asked } = Reader([{ frontier: 9999, events }, {}]);
      await Settled(Step(reqId, env));
      expect(After(asked[1])).to.equal(String(limit));
    });
  });

  it("scopes the read to the instance the query named, and reads every instance across them", async () => {
    const scoped = Reader([{}]);
    await Feed(async (reqId) => {
      await Settled(Step(reqId, scoped.env));
      expect(scoped.asked[0].args).to.include("default");
    });
    const across = Reader([{}]);
    await Feed(async (reqId) => {
      await Settled(ReadFeedEvents(reqId, Stages(CROSS_INSTANCE), across.env));
      expect(across.asked[0].args).to.not.include("default");
      expect(across.asked[0].sql).to.not.contain("`inst` =");
    });
  });
});

async function First(
  answer: Answer,
  ...between: QueryStage[]
): Promise<RowObject> {
  const { env } = Reader([answer, {}]);
  const events = await Feed((reqId) => Step(reqId, env, ...between));
  expect(events).to.have.length(1);
  return events[0];
}

describe("a change feed's events", () => {
  it("delivers an insert as an added event carrying only the new value", async () => {
    const event = await First({
      events: [
        {
          seq: 1,
          op: "added",
          old: ABSENT,
          new: Matched({ _id: "a", car: "Renault" }),
        },
      ],
    });
    expect(event).to.have.property("changeType", "added");
    expect(event).to.not.have.property("oldValue");
    expect(event).to.have.deep.property("newValue", {
      _id: "a",
      car: "Renault",
    });
  });

  it("delivers a delete as a removed event carrying only the old value", async () => {
    const event = await First({
      events: [{ seq: 1, op: "removed", old: Matched({ _id: "a" }) }],
    });
    expect(event).to.have.property("changeType", "removed");
    expect(event).to.not.have.property("newValue");
    expect(event).to.have.deep.property("oldValue", { _id: "a" });
  });

  it("delivers an update as a modified event carrying both sides", async () => {
    const event = await First({
      events: [
        {
          seq: 1,
          op: "modified",
          old: Matched({ _id: "a", price: 1 }),
          new: Matched({ _id: "a", price: 2 }),
        },
      ],
    });
    expect(event).to.deep.equal({
      changeType: "modified",
      oldValue: { _id: "a", price: 1 },
      newValue: { _id: "a", price: 2 },
    });
  });

  it("delivers a row leaving the filter, with both sides", async () => {
    const event = await First({
      events: [
        {
          seq: 1,
          op: "modified",
          old: Matched({ _id: "a", price: 50 }, true),
          new: Matched({ _id: "a", price: 200 }, false),
        },
      ],
    });
    expect(event).to.deep.equal({
      changeType: "modified",
      oldValue: { _id: "a", price: 50 },
      newValue: { _id: "a", price: 200 },
    });
  });

  it("delivers a row entering the filter, with both sides", async () => {
    const event = await First({
      events: [
        {
          seq: 1,
          op: "modified",
          old: Matched({ _id: "a", price: 200 }, false),
          new: Matched({ _id: "a", price: 50 }, true),
        },
      ],
    });
    expect(event).to.have.nested.property("oldValue.price", 200);
    expect(event).to.have.nested.property("newValue.price", 50);
  });

  it("skips a row that matched on neither side, and delivers the next", async () => {
    const event = await First({
      events: [
        {
          seq: 1,
          op: "modified",
          old: Matched({ _id: "a" }, false),
          new: Matched({ _id: "a" }, false),
        },
        { seq: 2, op: "added", new: Matched({ _id: "b" }) },
      ],
    });
    expect(event).to.have.nested.property("newValue._id", "b");
  });

  it("answers the events one poll admitted in a single read, in order", async () => {
    const { env } = Reader([
      {
        events: [
          { seq: 1, op: "added", new: Matched({ _id: "first" }) },
          { seq: 2, op: "added", new: Matched({ _id: "second" }) },
          { seq: 3, op: "added", new: Matched({ _id: "third" }) },
        ],
      },
    ]);
    const events = await Feed((reqId) => Step(reqId, env));
    expect(events.map((event) => event.newValue)).to.deep.equal([
      { _id: "first" },
      { _id: "second" },
      { _id: "third" },
    ]);
  });
});
