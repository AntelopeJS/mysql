import { expect } from "chai";
import type { PoolConnection } from "mysql2/promise";
import { Schema } from "@antelopejs/interface-database/schema";

import { type Sql, ident, param, sql } from "../statement";
import { AcquireConnection, GetDialect, Read } from "../connection";
import { OnDedicatedSession } from "../implementations/database/locks";
import { ReapOnce } from "../implementations/database/reaper";
import { CHANGE_LOG } from "../implementations/database/registry";
import { PhysicalTable, Run } from "./tables";
import {
  Delivered,
  type Feed,
  type Nest,
  Opened,
  Pause,
  QUIET_MS,
  type Row,
  SettlesWithin,
} from "./watch";

/** A retention every row logged before the pause exceeds. */
const RETENTION_MS = 1;
const PAUSE_MS = 20;
const REAP_DEADLINE_MS = 10_000;

const sequenced = new Schema<{ rows: Row }>("feeds-sequencer", {
  rows: { fields: { label: "string", meta: "object" }, indexes: {} },
});

describe("the order a change feed delivers in", function () {
  this.timeout(30_000);

  let first: PoolConnection;
  let second: PoolConnection;
  let feed: Feed;
  let table: Sql;

  before(async () => {
    first = await AcquireConnection();
    second = await AcquireConnection();
    table = ident(PhysicalTable("feeds-sequencer", "rows"));
    feed = await Opened(sequenced.instance().table("rows"), "probe");
  });

  after(async () => {
    await feed.return?.();
    first.release();
    second.release();
  });

  function Insert(id: string, label: string) {
    return sql`INSERT INTO ${table} (_id, _instance, label) VALUES (${param(id)}, '', ${param(label)})`;
  }

  function Relabel(id: string, label: string) {
    return sql`UPDATE ${table} SET label = ${param(label)} WHERE _instance = '' AND _id = ${param(id)}`;
  }

  it("delivers a later commit first while an earlier transaction holds its row, then the held row once it commits", async () => {
    await Run(sql`START TRANSACTION`, first);
    await Run(Insert("held", "a"), first);
    await Run(Insert("later", "b"), second);
    expect(await Delivered(feed.next())).to.have.nested.property(
      "newValue._id",
      "later",
    );
    const held = feed.next();
    expect(
      await SettlesWithin(held, QUIET_MS),
      "nothing is delivered while the held transaction is open",
    ).to.equal(false);
    await Run(sql`COMMIT`, first);
    expect(await Delivered(held)).to.deep.include({
      changeType: "added",
      newValue: { _id: "held", label: "a" },
    });
  });

  it("keeps two writes of one row in the order they committed", async () => {
    await Run(sql`START TRANSACTION`, first);
    await Run(Relabel("held", "v1"), first);
    const waiting = Run(Relabel("held", "v2"), second);
    await Pause(QUIET_MS);
    await Run(sql`COMMIT`, first);
    await waiting;
    const one = await Delivered(feed.next());
    const two = await Delivered(feed.next());
    expect(one).to.have.property("changeType", "modified");
    expect(one).to.have.nested.property("oldValue.label", "a");
    expect(one).to.have.nested.property("newValue.label", "v1");
    expect(two).to.have.nested.property("oldValue.label", "v1");
    expect(two).to.have.nested.property("newValue.label", "v2");
  });

  it("delivers a JSON column going from SQL NULL to JSON null as the key appearing with null", async () => {
    await Run(
      sql`UPDATE ${table} SET meta = ${GetDialect().sql.json.null} WHERE _instance = '' AND _id = 'later'`,
    );
    const change = await Delivered(feed.next());
    expect(change).to.have.property("changeType", "modified");
    expect(change)
      .to.have.property("oldValue")
      .that.does.not.have.property("meta");
    expect(change).to.have.nested.property("newValue.meta", null);
  });
});

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

const deep = new Schema<{ stored: Row; delivered: Row }>("feeds-depth", {
  stored: { fields: { label: "string", tree: "object" }, indexes: {} },
  delivered: { fields: { label: "string", tree: "object" }, indexes: {} },
});

describe("a watched table holding JSON as deep as the server stores it", function () {
  this.timeout(30_000);
  let depths: Awaited<ReturnType<typeof Depths>>;

  before(async () => {
    depths = await Depths();
  });

  it("updates and deletes a row stored before it was watched", async () => {
    const rows = deep.instance().table("stored");
    await rows.insert({
      _id: "deep",
      deep: Nested(depths.inExtra),
      tree: Nested(depths.inColumn),
    });
    const feed = await Opened(rows, "probe");
    await feed.return?.();
    expect(await rows.get("deep").update({ label: "changed" })).to.equal(1);
    expect(await rows.get("deep")).to.have.property("label", "changed");
    expect(await rows.get("deep").delete()).to.equal(1);
    expect(await rows.get("deep")).to.equal(undefined);
  });

  it("logs a column of empty arrays nested to each depth around the image's limit", async () => {
    const rows = deep.instance().table("stored");
    await rows.insert({ _id: "hollow" });
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
    expect(await rows.get("hollow").delete()).to.equal(1);
  });

  it("delivers the changes of a row as deep as a document holds", async () => {
    const rows = deep.instance().table("delivered");
    const stored = {
      deep: Nested(depths.inExtra),
      tree: Nested(depths.inDocument),
    };
    await rows.insert({ _id: "deep", ...stored });
    const feed = await Opened(rows, "probe");
    try {
      expect(await rows.get("deep").update({ label: "changed" })).to.equal(1);
      const modified = await Delivered(feed.next());
      expect(modified.oldValue).to.deep.equal({ _id: "deep", ...stored });
      expect(modified.newValue).to.deep.equal({
        _id: "deep",
        label: "changed",
        ...stored,
      });
      expect(await rows.get("deep").delete()).to.equal(1);
      const removed = await Delivered(feed.next());
      expect(removed).to.have.property("changeType", "removed");
      expect(removed.oldValue).to.deep.include(stored);
    } finally {
      await feed.return?.();
    }
  });
});

const numbered = new Schema<{ rows: Row }>("feeds-numbers", {
  rows: { fields: { label: "string", meta: "object" }, indexes: {} },
});

/** A double whose shortest spelling MySQL 8.4 reads back from JSON text as a neighbouring double. */
const LONG_DOUBLE = 123456789.12345679;

describe("a change feed's images of a JSON column", function () {
  this.timeout(30_000);

  it("deliver the doubles it holds exactly", async () => {
    const rows = numbered.instance().table("rows");
    const meta = { long: LONG_DOUBLE, sum: 0.1 + 0.2 };
    await rows.insert({ _id: "exact", meta });
    expect(await rows.get("exact")).to.have.deep.property("meta", meta);
    const feed = await Opened(rows, "probe");
    try {
      await rows.get("exact").update({ label: "changed" });
      const modified = await Delivered(feed.next());
      expect({
        before: modified.oldValue?.meta,
        after: modified.newValue?.meta,
      }).to.deep.equal({ before: meta, after: meta });
    } finally {
      await feed.return?.();
    }
  });
});

const churned = new Schema<{ quiet: Row; busy: Row }>("feeds-quiet", {
  quiet: { fields: { label: "string" }, indexes: {} },
  busy: { fields: { label: "string" }, indexes: {} },
});

const Quiet = () => churned.instance().table("quiet");
const Busy = () => churned.instance().table("busy");

/**
 * Logs `count` rows on the busy table, then reaps until none of the busy table's rows is left in
 * the log. One pass may reap nothing: the module's own reaper can hold the pass, and a sequencer
 * pass already running can number the rows after the pause, too late to be past retention.
 */
async function ChurnPastRetention(count: number): Promise<void> {
  const rows = Array.from({ length: count }, (_, index) => ({
    _id: `busy-${Date.now()}-${index}`,
  }));
  await Busy().insert(rows);
  const dialect = GetDialect();
  const logged = PhysicalTable("feeds-quiet", "busy");
  const deadline = Date.now() + REAP_DEADLINE_MS;
  for (;;) {
    await Pause(PAUSE_MS);
    const left = await OnDedicatedSession(async (session) => {
      await ReapOnce(session, dialect, RETENTION_MS);
      const [row] = await session.read(
        sql`SELECT COUNT(*) AS n FROM ${ident(CHANGE_LOG.log)} WHERE tbl = ${param(logged)}`,
      );
      return Number(row?.get("n"));
    });
    if (left === 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${String(left)} rows of the busy table are still logged after ${String(REAP_DEADLINE_MS)} ms of reaping`,
      );
    }
  }
}

describe("a change feed and the reaper", function () {
  this.timeout(30_000);

  let quiet: Feed;
  let busy: Feed;

  before(async () => {
    busy = await Opened(Busy(), "busy-probe");
    quiet = await Opened(Quiet(), "quiet-probe");
  });

  after(async () => {
    await quiet.return?.();
    await busy.return?.();
  });

  it("never ends a feed on a table nobody writes as lapsed while another table churns past retention", async () => {
    const waiting = quiet.next();
    await ChurnPastRetention(50);
    await Quiet().insert({ _id: "quiet-after" });
    expect(await Delivered(waiting)).to.have.nested.property(
      "newValue._id",
      "quiet-after",
    );
  });

  it("ends a feed as lapsed when rows of its own table were reaped before it read them", async () => {
    const failure = await busy.next().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).to.be.instanceOf(Error);
    expect(String(failure)).to.contain("fell behind the retention window");
  });
});
