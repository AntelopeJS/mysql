import { expect } from "chai";
import { type Connection, createConnection } from "mysql2/promise";
import { Schema } from "@antelopejs/interface-database/schema";

import { Bind, ident, sql } from "../statement";
import { GetOptions } from "../config";
import { GetDialect, Read } from "../connection";
import { Schemas } from "../implementations/database/schema";
import { SchemaKey } from "../implementations/database/registry";
import { PhysicalTable, Reconnect } from "./tables";
import { Pause } from "./watch";

interface Item {
  _id: string;
  label: string;
}

const DEFINITION = { items: { fields: { label: "string" }, indexes: {} } };

const WIDER = {
  items: { fields: { label: "string", note: "string" }, indexes: {} },
};

/** Far longer than a reconnect takes, and shorter than the test holds the tables lock. */
const RECONNECT_MS = 3000;

/** Longer than a tables phase takes to reach an ALTER that waits on a lock, and to give up on it. */
const WAITING_DEADLINE_MS = 15_000;

/** Far shorter than the pause a tables phase takes after a lock timeout before it tries again. */
const POLL_MS = 5;

const WRITTEN: Item = { _id: "one", label: "after" };

/** Writes {@link WRITTEN} through the schema and answers what reading it back finds. */
async function WrittenAndRead(schema: Schema<{ items: Item }>) {
  const items = schema.instance().table("items");
  await items.insert(WRITTEN);
  return items.get(WRITTEN._id);
}

/** A session outside the pool, as another process would hold. */
async function OtherProcess(): Promise<Connection> {
  return createConnection(GetOptions().url ?? "");
}

/** Takes the schema's tables lock on a session outside the pool. */
async function HoldTablesLock(schemaId: string): Promise<Connection> {
  const holder = await OtherProcess();
  const { session } = GetDialect();
  const url = new URL(GetOptions().url ?? "");
  const database = decodeURIComponent(url.pathname.slice(1));
  const name = session.lockName("tables", `${database}/${SchemaKey(schemaId)}`);
  const lock = Bind(session.acquireLock(name, 0));
  await holder.query(lock.sql, [...lock.args]);
  return holder;
}

/** Holds a metadata lock on the schema's table, from an open transaction outside the pool. */
async function HoldTableLock(schemaId: string): Promise<Connection> {
  const holder = await OtherProcess();
  await holder.query("START TRANSACTION");
  await holder.query(
    Bind(sql`SELECT * FROM ${ident(PhysicalTable(schemaId))}`).sql,
  );
  return holder;
}

async function AlterWaitingOnLock(): Promise<boolean> {
  const rows = await Read(
    sql`SELECT 1 AS waiting FROM information_schema.PROCESSLIST WHERE STATE = 'Waiting for table metadata lock' AND INFO LIKE 'ALTER TABLE%'`,
  );
  return rows.length > 0;
}

/** Polls until an ALTER is, or is no longer, waiting on a metadata lock. */
async function UntilAlterWaiting(waiting: boolean, what: string) {
  const deadline = Date.now() + WAITING_DEADLINE_MS;
  while ((await AlterWaitingOnLock()) !== waiting) {
    if (Date.now() > deadline) {
      expect.fail(what);
    }
    await Pause(POLL_MS);
  }
}

/**
 * Fails on a disconnect that ends the pool under a tables phase and keeps the failure for good, on
 * one that waits for a tables phase still queued behind another process's lock, and on a gate that
 * hands the first call after a reconnect a tables phase still running on the ended pool.
 */
describe("a schema whose registration is still converging when the adapter reconnects", function () {
  this.timeout(60_000);

  const ids = ["reconnect-converging", "reconnect-queued", "reconnect-stale"];

  after(() => {
    for (const id of ids) {
      Schemas.unregister(id);
    }
  });

  it("converges, and serves writes and reads once reconnected", async () => {
    const schema = new Schema<{ items: Item }>(ids[0], DEFINITION);
    await Reconnect(GetOptions());
    expect(await WrittenAndRead(schema)).to.deep.equal(WRITTEN);
  });

  it("lets the adapter reconnect while another process holds its tables lock, and converges once that process is done", async () => {
    const holder = await HoldTablesLock(ids[1]);
    const schema = new Schema<{ items: Item }>(ids[1], DEFINITION);
    try {
      const outcome = await Promise.race([
        Reconnect(GetOptions()).then(() => "reconnected"),
        Pause(RECONNECT_MS).then(() => "still disconnecting"),
      ]);
      expect(outcome).to.equal("reconnected");
    } finally {
      await holder.end();
    }
    expect(await WrittenAndRead(schema)).to.deep.equal(WRITTEN);
  });

  it("serves the first call after a reconnect that ended the pool under a tables phase pausing between lock attempts", async () => {
    expect(
      await WrittenAndRead(new Schema<{ items: Item }>(ids[2], DEFINITION)),
    ).to.deep.equal(WRITTEN);
    const holder = await HoldTableLock(ids[2]);
    const wider = new Schema<{ items: Item }>(ids[2], WIDER);
    try {
      await UntilAlterWaiting(
        true,
        "the tables phase runs an ALTER that waits on the lock",
      );
      await UntilAlterWaiting(false, "the ALTER gives up on the lock");
      await Reconnect(GetOptions());
    } finally {
      await holder.end();
    }
    expect(
      await wider.instance().table("items").get(WRITTEN._id),
    ).to.deep.equal(WRITTEN);
  });
});
