import { expect } from "chai";
import type { PoolConnection } from "mysql2/promise";
import { Schema } from "@antelopejs/interface-database/schema";

import { ident, param, sql } from "../statement";
import { AcquireConnection, GetDialect, Read } from "../connection";
import { SessionOf } from "../implementations/database/locks";
import { CHANGE_LOG } from "../implementations/database/registry";
import { SequenceOnce } from "../implementations/database/sequencer";
import { Numbers, PhysicalTable, Run } from "./tables";
import { Delivered, type Feed, Opened, Pause, type Row } from "./watch";

const SCHEMA_ID = "feeds-row-order";

const ordered = new Schema<{ rows: Row }>(SCHEMA_ID, {
  rows: { fields: { label: "string" }, indexes: {} },
});

/**
 * Ten to this power is how many log rows an open transaction holds, which a pass has to read past
 * before it reaches the rows logged after them: about a second's reading on 8.4 and 9.7.
 */
const BACKLOG_PLACES = 6;

/** Long enough for a pass that started reading the log to have read past its first row. */
const SCAN_HEAD_MS = 50;

const POLL_MS = 2;

/** Longer than a pass takes to start once its connection is free. */
const START_DEADLINE_MS = 30_000;

/** Whether the connection `id` is running a `SELECT` that reads the change log. */
async function ReadingLog(id: number): Promise<boolean> {
  const rows = await Read(
    sql`SELECT 1 AS reading FROM performance_schema.processlist WHERE ID = ${param(id)} AND INFO LIKE 'SELECT%' AND LOCATE(${param(CHANGE_LOG.log)}, INFO) > 0`,
  );
  return rows.length > 0;
}

async function StartedReadingLog(id: number): Promise<void> {
  const deadline = Date.now() + START_DEADLINE_MS;
  while (!(await ReadingLog(id))) {
    if (Date.now() > deadline) {
      expect.fail("the sequencer pass reads the change log");
    }
    await Pause(POLL_MS);
  }
}

describe("a sequencer pass reading the log while one document is written twice", function () {
  this.timeout(120_000);

  let writer: PoolConnection;
  let backlog: PoolConnection;
  let sequencer: PoolConnection;
  let feed: Feed;

  function Relabel(label: string) {
    return sql`UPDATE ${ident(PhysicalTable(SCHEMA_ID, "rows"))} SET label = ${param(label)} WHERE _instance = '' AND _id = 'twice'`;
  }

  before(async () => {
    writer = await AcquireConnection();
    backlog = await AcquireConnection();
    sequencer = await AcquireConnection();
    const rows = ordered.instance().table("rows");
    feed = await Opened(rows, "probe");
    await rows.insert({ _id: "twice", label: "initial" });
    await Delivered(feed.next());
  });

  after(async () => {
    await feed.return?.();
    writer.release();
    backlog.release();
    sequencer.release();
  });

  /**
   * The first write commits after the pass began reading the log, and the second one, which waited
   * on the document's lock, commits while the pass still reads. A pass that judges each row as it
   * reaches it skips the first one, still open when read, and numbers the second, so the feed
   * delivers the document's second write before its first.
   */
  it("numbers the first write before the second, though both commit while the pass reads", async () => {
    await Run(sql`START TRANSACTION`, writer);
    await Run(Relabel("first"), writer);
    await Run(sql`START TRANSACTION`, backlog);
    await Run(
      sql`INSERT INTO ${ident(CHANGE_LOG.log)} (tbl, inst, op) SELECT 'backlog', '', 'added' FROM ${Numbers(BACKLOG_PLACES)} AS numbers`,
      backlog,
    );
    const pass = SequenceOnce(SessionOf(sequencer), GetDialect(), "wait");
    try {
      await StartedReadingLog(sequencer.threadId);
      await Pause(SCAN_HEAD_MS);
      await Run(sql`COMMIT`, writer);
      await Run(Relabel("second"));
      expect(
        await ReadingLog(sequencer.threadId),
        "the pass still reads the log once the second write has committed",
      ).to.equal(true);
    } finally {
      await pass;
      await Run(sql`ROLLBACK`, backlog);
    }
    const one = await Delivered(feed.next());
    const two = await Delivered(feed.next());
    expect(
      [one.newValue?.label, two.newValue?.label],
      "the feed delivers the document's writes in the order they committed",
    ).to.deep.equal(["first", "second"]);
  });
});
