import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

import { ident, param, sql } from "../statement";
import { GetDialect, Read } from "../connection";
import { PhysicalTable, Run } from "./tables";
import {
  Delivered,
  DeliveredRow,
  type Nest,
  Opened,
  OpenedOver,
  type Row,
  SettlesWithin,
} from "./watch";

/** A value nested `levels` objects deep. */
function Nested(levels: number): Nest {
  let value: Nest = "🦌 deep";
  for (let level = 0; level < levels; level += 1) {
    value = { n: value };
  }
  return value;
}

/** The most levels this suite nests a value to: MySQL refuses a 101st. */
const MOST_LEVELS = 100;

/**
 * The deepest a stored JSON value nests on the server: MySQL refuses a 101st level, MariaDB 11.8 a
 * 32nd. An undeclared field sits one level down in `_extra`, a declared object field holds its
 * value at the top of its own column, and a declared field one level short of the limit leaves
 * room for the document around it.
 */
async function Depths() {
  let inColumn = MOST_LEVELS;
  while (!(await Nests(inColumn))) {
    inColumn -= 1;
  }
  return { inColumn, inExtra: inColumn - 1, inDocument: inColumn - 1 };
}

async function Nests(levels: number): Promise<boolean> {
  const text = `${"[".repeat(levels)}${"]".repeat(levels)}`;
  const [row] = await Read(sql`SELECT JSON_VALID(${param(text)}) AS valid`);
  return Number(row.get("valid")) === 1;
}

/** Whether the server builds a document `levels` deep; MySQL refuses to with an error. */
async function Builds(levels: number): Promise<boolean> {
  return Nests(levels).catch(() => false);
}

/** Whether the server fails a statement that builds a document `levels` deep, as MySQL does. */
async function Refuses(levels: number): Promise<boolean> {
  return Nests(levels).then(
    () => false,
    () => true,
  );
}

/** A value nested `levels` objects deep, the innermost one empty. */
function Hollow(levels: number): Nest {
  let value: Nest = {};
  for (let level = 1; level < levels; level += 1) {
    value = { n: value };
  }
  return value;
}

/** How long a feed may take to end once it reaches an event it cannot deliver. */
const ENDS_WITHIN_MS = 2000;

/** What a read settled to, as text, once it settles within {@link ENDS_WITHIN_MS}. */
async function Settled(next: Promise<IteratorResult<unknown, void>>) {
  expect(await SettlesWithin(next, ENDS_WITHIN_MS)).to.equal(true);
  return next.then(
    (step) => `delivered ${JSON.stringify(step.value)}`,
    (err: unknown) => String(err),
  );
}

const ENDED =
  /cannot deliver its next event after seq \d+: the event's document nests deeper than the server builds/;

const DEPTH_TABLE = {
  fields: { label: "string", tree: "object" },
  indexes: {},
} as const;

const deep = new Schema<{
  stored: Row;
  delivered: Row;
  ending: Row;
  projected: Row;
  hollowed: Row;
  mapped: Row;
  hollows: Row;
  plucks: Row;
  merges: Row;
}>("feeds-depth", {
  stored: DEPTH_TABLE,
  delivered: DEPTH_TABLE,
  ending: DEPTH_TABLE,
  projected: DEPTH_TABLE,
  hollowed: DEPTH_TABLE,
  mapped: DEPTH_TABLE,
  hollows: DEPTH_TABLE,
  plucks: DEPTH_TABLE,
  merges: DEPTH_TABLE,
});

describe("a watched table holding JSON as deep as the server stores it", function () {
  this.timeout(30_000);
  let depths: Awaited<ReturnType<typeof Depths>>;

  before(async () => {
    depths = await Depths();
  });

  it("updates and deletes a row stored before it was watched", async () => {
    const rows = deep.instance().table("stored");
    await rows
      .insert({
        _id: "deep",
        deep: Nested(depths.inExtra),
        tree: Nested(depths.inColumn),
      })
      .run();
    const feed = await Opened(rows, "probe");
    await feed.return?.();
    expect(await rows.get("deep").update({ label: "changed" }).run()).to.equal(
      1,
    );
    expect(await rows.get("deep").run()).to.have.property("label", "changed");
    expect(await rows.get("deep").delete().run()).to.equal(1);
    expect(await rows.get("deep").run()).to.equal(undefined);
  });

  it("logs a column of empty arrays nested to each depth around the image's limit", async () => {
    const rows = deep.instance().table("stored");
    await rows.insert({ _id: "hollow" }).run();
    const feed = await Opened(rows, "hollow-probe");
    await feed.return?.();
    const table = ident(PhysicalTable("feeds-depth", "stored"));
    const limit = depths.inColumn;
    for (const levels of [limit - 2, limit - 1, limit]) {
      const hollow = `${"[".repeat(levels)}${"]".repeat(levels)}`;
      await Run(
        sql`UPDATE ${table} SET tree = ${GetDialect().sql.json.parse(param(hollow))} WHERE _instance = '' AND _id = 'hollow'`,
      );
    }
    expect(await rows.get("hollow").delete().run()).to.equal(1);
  });

  it("delivers the changes of a row as deep as a document holds", async () => {
    const rows = deep.instance().table("delivered");
    const stored = {
      deep: Nested(depths.inExtra),
      tree: Nested(depths.inDocument),
    };
    await rows.insert({ _id: "deep", ...stored }).run();
    const feed = await Opened(rows, "probe");
    try {
      expect(
        await rows.get("deep").update({ label: "changed" }).run(),
      ).to.equal(1);
      const modified = await Delivered(feed.next());
      expect(modified.oldValue).to.deep.equal({ _id: "deep", ...stored });
      expect(modified.newValue).to.deep.equal({
        _id: "deep",
        label: "changed",
        ...stored,
      });
      expect(await rows.get("deep").delete().run()).to.equal(1);
      const removed = await Delivered(feed.next());
      expect(removed).to.have.property("changeType", "removed");
      expect(removed.oldValue).to.deep.include(stored);
    } finally {
      await feed.return?.();
    }
  });

  /**
   * MariaDB's poll reads an image inside one more array, so a field 29 containers deep whose
   * innermost one is empty, which `JSON_DEPTH` measures as deep as one 28 containers deep around a
   * string, failed the poll as nested too deep, and the feed ended at a document it builds.
   */
  it("delivers a field whose innermost object is empty, at each depth a document around it holds", async () => {
    const rows = deep.instance().table("hollows");
    const feed = await Opened(rows, "hollows");
    try {
      const levels = [3, 2, 1].map((short) => depths.inColumn - short);
      await rows
        .insert(
          levels.map((level) => ({
            _id: `hollow-${level}`,
            tree: Hollow(level),
          })),
        )
        .run();
      for (const level of levels) {
        const id = `hollow-${level}`;
        expect((await DeliveredRow(feed, id)).newValue).to.deep.equal({
          _id: id,
          tree: Hollow(level),
        });
      }
    } finally {
      await feed.return?.();
    }
  });
});

describe("a change feed reaching a document deeper than the server builds", function () {
  this.timeout(30_000);
  let depths: Awaited<ReturnType<typeof Depths>>;

  before(async () => {
    depths = await Depths();
  });

  /**
   * A document around a field as deep as the server stores is one level deeper still. MySQL fails
   * the poll that builds it and MariaDB 11.8 builds SQL NULL, so the feed either retried until the
   * event was reaped or delivered a null document. MariaDB 12.3 builds it, and delivers it.
   */
  it("ends at once, naming where it stopped, at a document deeper than the server builds", async () => {
    const rows = deep.instance().table("ending");
    const feed = await Opened(rows, "ending");
    try {
      await rows.insert({ _id: "shallow", label: "before" }).run();
      await rows
        .insert({ _id: "deepest", tree: Nested(depths.inColumn) })
        .run();
      expect(await DeliveredRow(feed, "shallow")).to.have.nested.property(
        "newValue.label",
        "before",
      );
      const next = feed.next();
      if (await Builds(depths.inColumn + 1)) {
        expect((await Delivered(next)).newValue).to.deep.equal({
          _id: "deepest",
          tree: Nested(depths.inColumn),
        });
        return;
      }
      expect(await Settled(next))
        .to.match(ENDED)
        .and.contain("feeds-depth.ending");
    } finally {
      await feed.return?.();
    }
  });

  /**
   * `JSON_DEPTH` counts no level inside an empty container, so such a field as deep as the server
   * stores measures a level short. A feed that judged depth by it read on: MySQL failed the poll of
   * the whole batch, losing the event committed ahead of it, and MariaDB 11.8 delivered a null
   * document.
   */
  it("ends after the events before it at a field whose innermost object is empty, as deep as the server stores", async () => {
    const rows = deep.instance().table("hollowed");
    const feed = await Opened(rows, "hollowed");
    try {
      const tree = Hollow(depths.inColumn);
      await rows
        .insert([
          { _id: "shallow", label: "before" },
          { _id: "hollowest", tree },
        ])
        .run();
      expect(await DeliveredRow(feed, "shallow")).to.have.nested.property(
        "newValue.label",
        "before",
      );
      const next = feed.next();
      if (await Builds(depths.inColumn + 1)) {
        expect((await Delivered(next)).newValue).to.deep.equal({
          _id: "hollowest",
          tree,
        });
        return;
      }
      expect(await Settled(next)).to.match(ENDED);
    } finally {
      await feed.return?.();
    }
  });

  /**
   * A `map` that wraps a field nests it deeper than the row does. MySQL fails the poll of the batch
   * holding it, and a feed that ended on that failure lost the events committed ahead of it in the
   * same batch. MariaDB builds it, since no function it passes through reads it, so only MySQL ends.
   */
  it("delivers the events a map builds ahead of one it nests too deep", async () => {
    const rows = deep.instance().table("mapped");
    const wrapped = rows
      .map((row) => ({ _id: row.key("_id"), w: { x: row.key("tree") } }))
      .changes()
      .cursor();
    const feed = await OpenedOver(wrapped, rows, { _id: "mapped" });
    try {
      await rows
        .insert([
          { _id: "first", tree: Nested(1) },
          { _id: "second", tree: Nested(1) },
          { _id: "wrapped", tree: Nested(depths.inDocument) },
        ])
        .run();
      expect(await DeliveredRow(feed, "first")).to.have.nested.property(
        "newValue.w.x.n",
        "🦌 deep",
      );
      expect(await DeliveredRow(feed, "second")).to.have.nested.property(
        "newValue.w.x.n",
        "🦌 deep",
      );
      if (await Refuses(depths.inDocument + 2)) {
        expect(await Settled(feed.next())).to.match(ENDED);
      }
    } finally {
      await feed.return?.();
    }
  });
});

describe("a change feed whose stages build a document deeper than the server builds", function () {
  this.timeout(30_000);
  let depths: Awaited<ReturnType<typeof Depths>>;

  before(async () => {
    depths = await Depths();
  });

  /**
   * A `pluck` that keeps a field as deep as the server stores, or a `without` that drops another,
   * builds a document as deep as the row's. MariaDB 11.8 answers SQL NULL for it, with a warning
   * rather than an error, and the feed delivered `null` as the document.
   */
  it("ends, naming where it stopped, at a projection deeper than the server builds", async () => {
    const rows = deep.instance().table("plucks");
    const plucked = await OpenedOver(
      rows.pluck("_id", "tree").changes().cursor(),
      rows,
      { _id: "plucked" },
    );
    const dropped = await OpenedOver(
      rows.without("label").changes().cursor(),
      rows,
      { _id: "dropped" },
    );
    try {
      const tree = Nested(depths.inColumn);
      await rows.insert({ _id: "shallow", label: "before" }).run();
      await rows.insert({ _id: "deepest", label: "deep", tree }).run();
      for (const feed of [plucked, dropped]) {
        expect(await DeliveredRow(feed, "shallow")).to.have.nested.property(
          "newValue._id",
          "shallow",
        );
        const next = feed.next();
        if (await Builds(depths.inColumn + 1)) {
          expect((await Delivered(next)).newValue).to.deep.equal({
            _id: "deepest",
            tree,
          });
          continue;
        }
        expect(await Settled(next))
          .to.match(ENDED)
          .and.contain("feeds-depth.plucks");
      }
    } finally {
      await plucked.return?.();
      await dropped.return?.();
    }
  });

  /**
   * MariaDB held each operand of a `merge` inside one more array, so a row as deep as a document
   * holds failed as nested too deep, and the feed ended at a merged document the server builds.
   */
  it("delivers a map that merges into a row as deep as a document holds", async () => {
    const rows = deep.instance().table("merges");
    const merged = await OpenedOver(
      rows
        .map((row) => row.merge({ label: "merged" }))
        .changes()
        .cursor(),
      rows,
      { _id: "merged" },
    );
    try {
      const tree = Nested(depths.inDocument);
      await rows.insert({ _id: "deep", label: "before", tree }).run();
      expect((await DeliveredRow(merged, "deep")).newValue).to.deep.equal({
        _id: "deep",
        label: "merged",
        tree,
      });
    } finally {
      await merged.return?.();
    }
  });
});

describe("a change feed whose stages never build a deep row's document", function () {
  this.timeout(30_000);
  let depths: Awaited<ReturnType<typeof Depths>>;

  before(async () => {
    depths = await Depths();
  });

  /**
   * A `pluck` that leaves the deep field out never builds it, and a `filter` the row fails never
   * delivers its event. A feed that ended at every event holding a field as deep as the server
   * stores, or that built the document of an event it does not deliver, ended at the row.
   */
  it("reads past a row as deep as the server stores through stages that never build its document", async () => {
    const rows = deep.instance().table("projected");
    const plucked = await OpenedOver(
      rows.pluck("_id", "label").changes().cursor(),
      rows,
      { _id: "plucked" },
    );
    const kept = await OpenedOver(
      rows
        .filter((row) => row.key("label").eq("keep"))
        .changes()
        .cursor(),
      rows,
      { _id: "kept", label: "keep" },
    );
    try {
      const tree = Nested(depths.inColumn);
      await rows.insert({ _id: "deepest", label: "drop", tree }).run();
      await rows.insert({ _id: "after", label: "keep" }).run();
      expect((await DeliveredRow(plucked, "deepest")).newValue).to.deep.equal({
        _id: "deepest",
        label: "drop",
      });
      expect(await DeliveredRow(plucked, "after")).to.have.nested.property(
        "newValue.label",
        "keep",
      );
      expect(await DeliveredRow(kept, "after")).to.have.nested.property(
        "newValue.label",
        "keep",
      );
    } finally {
      await plucked.return?.();
      await kept.return?.();
    }
  });
});
