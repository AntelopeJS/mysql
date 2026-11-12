import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

import { type Sql, ident, sql } from "../statement";
import { AcquireConnection, Read } from "../connection";
import { CHANGE_LOG } from "../implementations/database/registry";
import { Schemas } from "../implementations/database/schema";
import { Run } from "./tables";
import { DeliveredRow, Opened, Pause, QUIET_MS, type Row } from "./watch";

const SCHEMA_ID = "feeds-log";
const DEFINITION = { rows: { fields: { label: "string" }, indexes: {} } };

/**
 * Long enough for the server's clock to reach the next second, the precision MySQL records a
 * table's creation at.
 */
const NEXT_SECOND_MS = 1100;

const logged = new Schema<{ rows: Row }>(SCHEMA_ID, DEFINITION);

/** The statement that creates the log as it stands, comment and all, as `mysqldump` writes it. */
async function LogDefinition(): Promise<string> {
  const [shown] = await Read(sql`SHOW CREATE TABLE ${ident(CHANGE_LOG.log)}`);
  return String(shown?.get("Create Table"));
}

async function RunText(statement: string): Promise<void> {
  const connection = await AcquireConnection();
  try {
    await connection.query(statement);
  } finally {
    connection.release();
  }
}

describe("a change log dropped and created again", function () {
  this.timeout(30_000);

  /**
   * The events written before the drop went with the log. A clock that kept its epoch across the
   * new log would let the feed read on from its watermark and skip them without a signal.
   */
  it("ends an open feed with the loss instead of skipping what it had not read", async () => {
    const rows = logged.instance().table("rows");
    const feed = await Opened(rows, "probe");
    try {
      await rows.insert({ _id: "unread", label: "lost with the log" });
      await Pause(QUIET_MS);
      await Run(sql`DROP TABLE ${ident(CHANGE_LOG.log)}`);
      await Schemas.register(SCHEMA_ID, DEFINITION);
      await rows.insert({ _id: "after", label: "logged anew" });
      const failure = await feed.next().then(
        (step) => `delivered ${JSON.stringify(step.value)}`,
        (err: unknown) => String(err),
      );
      expect(failure).to.contain("the change log was recreated");
    } finally {
      await feed.return?.();
    }
  });

  /** A dump or a schema copy writes the log's comment out, so a log created from it inherits that. */
  it("ends an open feed with the loss when the log is created again from its own definition", async () => {
    const rows = logged.instance().table("rows");
    const feed = await Opened(rows, "copied");
    try {
      const definition = await LogDefinition();
      await rows.insert({ _id: "unread-copied", label: "lost with the log" });
      await Pause(NEXT_SECOND_MS);
      await Run(sql`DROP TABLE ${ident(CHANGE_LOG.log)}`);
      await RunText(definition);
      await Schemas.register(SCHEMA_ID, DEFINITION);
      await rows.insert({ _id: "after-copied", label: "logged anew" });
      const failure = await feed.next().then(
        (step) => `delivered ${JSON.stringify(step.value)}`,
        (err: unknown) => String(err),
      );
      expect(failure).to.contain("the change log was recreated");
    } finally {
      await feed.return?.();
    }
  });
});

/** What an open feed answers next, once `change` ran on the log with no registration after it. */
async function AnsweredAfter(probe: string, change: Sql): Promise<string> {
  const rows = logged.instance().table("rows");
  const feed = await Opened(rows, probe);
  try {
    await rows.insert({ _id: `${probe}-unread`, label: "written before" });
    await Pause(NEXT_SECOND_MS);
    await Run(change);
    await rows.insert({ _id: `${probe}-after`, label: "logged anew" });
    return await feed.next().then(
      (step) => `delivered ${JSON.stringify(step.value)}`,
      (err: unknown) => String(err),
    );
  } finally {
    await feed.return?.();
  }
}

describe("a change log emptied or altered under an open feed", function () {
  this.timeout(30_000);

  /** `TRUNCATE` takes the rows the feed had not read and fires no trigger. */
  it("ends the feed with the loss when the log is truncated", async () => {
    const answer = await AnsweredAfter(
      "truncated",
      sql`TRUNCATE TABLE ${ident(CHANGE_LOG.log)}`,
    );
    expect(answer).to.contain(
      "the change log was recreated, altered or emptied",
    );
  });

  /** An `ALTER` gives the log another creation time, which is all a recreated log shows either. */
  it("ends the feed with the loss when the log is altered", async () => {
    const answer = await AnsweredAfter(
      "altered",
      sql`ALTER TABLE ${ident(CHANGE_LOG.log)} COMMENT = 'altered by hand'`,
    );
    expect(answer).to.contain(
      "the change log was recreated, altered or emptied",
    );
  });

  /** A registration that took the altered log for a new one would end a feed that lost nothing. */
  it("keeps a feed opened after the log was altered and emptied open through a registration", async () => {
    await Pause(NEXT_SECOND_MS);
    await Run(
      sql`ALTER TABLE ${ident(CHANGE_LOG.log)} COMMENT = 'altered again'`,
    );
    await Run(sql`TRUNCATE TABLE ${ident(CHANGE_LOG.log)}`);
    const rows = logged.instance().table("rows");
    const feed = await Opened(rows, "reopened");
    try {
      await Schemas.register(SCHEMA_ID, DEFINITION);
      await rows.insert({ _id: "reopened-after", label: "logged anew" });
      expect(
        await DeliveredRow(feed, "reopened-after"),
      ).to.have.nested.property("newValue.label", "logged anew");
    } finally {
      await feed.return?.();
    }
  });
});
