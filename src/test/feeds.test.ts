import { expect } from "chai";
import type { PoolConnection } from "mysql2/promise";
import { Schema } from "@antelopejs/interface-database/schema";

import { type Sql, ident, param, sql } from "../statement";
import { AcquireConnection, GetDialect } from "../connection";
import { OnDedicatedSession } from "../implementations/database/locks";
import { ReapOnce } from "../implementations/database/reaper";
import { PhysicalTable, Run } from "./tables";
import {
  Delivered,
  type Feed,
  Opened,
  Pause,
  QUIET_MS,
  type Row,
  SettlesWithin,
} from "./watch";

/** A retention every row logged before the pause exceeds. */
const RETENTION_MS = 1;
const PAUSE_MS = 20;

const sequenced = new Schema<{ rows: Row }>("feeds-sequencer", {
  rows: { fields: { label: "string", meta: "object" }, indexes: {} },
});

describe("change feeds in commit order", function () {
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
      sql`UPDATE ${table} SET meta = CAST('null' AS JSON) WHERE _instance = '' AND _id = 'later'`,
    );
    const change = await Delivered(feed.next());
    expect(change).to.have.property("changeType", "modified");
    expect(change)
      .to.have.property("oldValue")
      .that.does.not.have.property("meta");
    expect(change).to.have.nested.property("newValue.meta", null);
  });
});

const churned = new Schema<{ quiet: Row; busy: Row }>("feeds-quiet", {
  quiet: { fields: { label: "string" }, indexes: {} },
  busy: { fields: { label: "string" }, indexes: {} },
});

const Quiet = () => churned.instance().table("quiet");
const Busy = () => churned.instance().table("busy");

/** Logs `count` rows on the busy table, then reaps everything logged before a short pause. */
async function ChurnPastRetention(count: number): Promise<void> {
  const rows = Array.from({ length: count }, (_, index) => ({
    _id: `busy-${Date.now()}-${index}`,
  }));
  await Busy().insert(rows);
  await Pause(PAUSE_MS);
  const dialect = GetDialect();
  await OnDedicatedSession((session) =>
    ReapOnce(session, dialect, RETENTION_MS),
  );
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
