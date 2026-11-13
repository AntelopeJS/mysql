import { expect } from "chai";
import type { PoolConnection } from "mysql2/promise";
import { Schema } from "@antelopejs/interface-database/schema";

import { type Sql, ident, int, lit, param, sql } from "../statement";
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
 * before it reaches the rows logged after them: about 1.5 s of reading on MySQL and 90 ms on
 * MariaDB, against the millisecond the server takes to commit both writes once the pass scans.
 */
const BACKLOG_PLACES = 6;

/**
 * Longer than InnoDB keeps the snapshot it answers `INNODB_TRX` from, which it takes again only once
 * the table has gone unread for 100 ms.
 */
const TRX_POLL_MS = 150;

/** Longer than a statement takes to reach the state a test waits for, once its connection is free. */
const STATE_DEADLINE_MS = 30_000;

/** The procedure that commits its caller's transaction once a given connection scans the log. */
const COMMIT_ON_SCAN = ident("feeds_row_order_commit_on_scan");

/**
 * Whether the connection `id` is scanning the change log in a `SELECT`: MySQL names a running scan
 * `executing` and MariaDB `Sending data`, while the statement before them is still being prepared.
 */
function Scanning(id: Sql): Sql {
  return sql`EXISTS (SELECT 1 FROM information_schema.PROCESSLIST WHERE ID = ${id} AND STATE IN ('executing', 'Sending data') AND INFO LIKE 'SELECT%' AND LOCATE(${lit(CHANGE_LOG.log)}, INFO) > 0)`;
}

/** Waits until the connection `id` runs a transaction that waits on a row lock. */
async function UntilWaitingOnRowLock(id: number): Promise<void> {
  const deadline = Date.now() + STATE_DEADLINE_MS;
  for (;;) {
    const rows = await Read(
      sql`SELECT 1 AS waiting FROM information_schema.INNODB_TRX WHERE trx_mysql_thread_id = ${param(id)} AND trx_state = 'LOCK WAIT'`,
    );
    if (rows.length > 0) {
      return;
    }
    if (Date.now() > deadline) {
      expect.fail("the second write waits on the document's lock");
    }
    await Pause(TRX_POLL_MS);
  }
}

/** Raises `premise` as the error of the statement that broke it. */
function Refuted(premise: string): Sql {
  return sql`SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = ${lit(premise)}`;
}

/**
 * Creates the procedure that commits the caller's transaction once the connection `pass` scans the
 * log, waits until the document in `table` reads as its second write, and refuses unless `pass`
 * still scans then. The server runs every step, so no round trip to a loaded client sits between
 * them.
 */
function CreateCommitOnScan(table: string): Sql {
  return sql`CREATE PROCEDURE ${COMMIT_ON_SCAN} (IN pass BIGINT UNSIGNED) BEGIN
  DECLARE deadline DATETIME(6) DEFAULT SYSDATE(6) + INTERVAL ${int(STATE_DEADLINE_MS)} * 1000 MICROSECOND;
  WHILE NOT ${Scanning(ident("pass"))} DO
    IF SYSDATE(6) > deadline THEN ${Refuted("the sequencer pass scans the change log")}; END IF;
  END WHILE;
  COMMIT;
  WHILE NOT EXISTS (SELECT 1 FROM ${ident(table)} WHERE _instance = '' AND _id = 'twice' AND label = 'second') DO
    IF SYSDATE(6) > deadline THEN ${Refuted("the second write commits once the first has")}; END IF;
  END WHILE;
  IF NOT ${Scanning(ident("pass"))} THEN ${Refuted("the pass still reads the log once the second write has committed")}; END IF;
END`;
}

describe("a sequencer pass reading the log while one document is written twice", function () {
  this.timeout(120_000);

  let writer: PoolConnection;
  let backlog: PoolConnection;
  let rewriter: PoolConnection;
  let sequencer: PoolConnection;
  let feed: Feed;

  function Relabel(label: string) {
    return sql`UPDATE ${ident(PhysicalTable(SCHEMA_ID, "rows"))} SET label = ${param(label)} WHERE _instance = '' AND _id = 'twice'`;
  }

  before(async () => {
    writer = await AcquireConnection();
    backlog = await AcquireConnection();
    rewriter = await AcquireConnection();
    sequencer = await AcquireConnection();
    await Run(sql`DROP PROCEDURE IF EXISTS ${COMMIT_ON_SCAN}`);
    await Run(CreateCommitOnScan(PhysicalTable(SCHEMA_ID, "rows")));
    const rows = ordered.instance().table("rows");
    feed = await Opened(rows, "probe");
    await rows.insert({ _id: "twice", label: "initial" });
    await Delivered(feed.next());
  });

  after(async () => {
    await feed.return?.();
    await Run(sql`DROP PROCEDURE IF EXISTS ${COMMIT_ON_SCAN}`);
    writer.release();
    backlog.release();
    rewriter.release();
    sequencer.release();
  });

  /**
   * The first write commits after the pass began scanning the log, and the second one, already
   * waiting on the document's lock, commits on the server as soon as the first does, while the pass
   * still reads past the backlog. A pass that judges each row as it reaches it skips the first one,
   * still open when read, and numbers the second, so the feed delivers the document's second write
   * before its first.
   */
  it("numbers the first write before the second, though both commit while the pass reads", async () => {
    await Run(sql`START TRANSACTION`, writer);
    await Run(Relabel("first"), writer);
    await Run(sql`START TRANSACTION`, backlog);
    await Run(
      sql`INSERT INTO ${ident(CHANGE_LOG.log)} (tbl, inst, op) SELECT 'backlog', '', 'added' FROM ${Numbers(BACKLOG_PLACES)} AS numbers`,
      backlog,
    );
    const second = Run(Relabel("second"), rewriter);
    let pass: Promise<unknown> = Promise.resolve();
    try {
      await UntilWaitingOnRowLock(rewriter.threadId);
      pass = SequenceOnce(SessionOf(sequencer), GetDialect(), "wait");
      await Run(
        sql`CALL ${COMMIT_ON_SCAN} (${param(sequencer.threadId)})`,
        writer,
      );
    } finally {
      await Run(sql`ROLLBACK`, writer);
      await Promise.all([second, pass]);
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
