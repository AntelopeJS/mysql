import { expect } from "chai";
import { setTimeout as delay } from "node:timers/promises";
import type { PoolConnection } from "mysql2/promise";
import { IsDuplicateKeyError } from "@antelopejs/interface-database";
import {
  Schema,
  type SchemaDefinition,
} from "@antelopejs/interface-database/schema";

import { ident, param, sql } from "../statement";
import { AcquireConnection, Read } from "../connection";
import { Schemas, WaitForIndexes } from "../implementations/database/schema";
import { PhysicalTable, Run } from "./tables";
import { SettlesWithin } from "./watch";

interface Item {
  _id?: string;
  price?: number;
}

type TableId = "items" | "others";

const SCHEMA_ID = "locked_unique";
const GONE_ID = "locked_unique_gone";
const FIELDS = { price: "number" } as const;
const BARE: SchemaDefinition = {
  items: { fields: FIELDS, indexes: {} },
  others: { fields: FIELDS, indexes: {} },
};
const UNIQUE_PRICE: SchemaDefinition = {
  items: { fields: FIELDS, indexes: { price: { unique: true } } },
  others: { fields: FIELDS, indexes: { price: { unique: true } } },
};

/**
 * Longer than the index phase's first pass takes to leave an index a lock holds off: 6 attempts that
 * each wait 5 s for the metadata lock, and 6.2 s of pauses between them.
 */
const PAST_GIVING_UP_MS = 45_000;

/** Longer than a later pass of the phase takes to start, and to build the index once nothing holds it. */
const BUILT_MS = 40_000;

/** Longer than the phase's second pass takes to start and to time out on the lock once. */
const LATER_PASS_MS = 10_000;

/** How long a read may queue behind one `ALTER` waiting 5 s for its metadata lock. */
const READ_MS = 10_000;

/** Longer than one `ALTER` waits for its metadata lock and the pause before the next attempt. */
const NEXT_ATTEMPT_MS = 8000;

/** How long an `ALTER` the phase runs takes to show in the process list, or to leave it once killed. */
const SETTLE_MS = 1000;

const POLL_MS = 100;

const schema = new Schema<{ items: Item; others: Item }>(
  SCHEMA_ID,
  UNIQUE_PRICE,
);

/** Starts the insert at once, settled to `"stored"` or to the error it threw. */
function Inserting(tableId: TableId, item: Item): Promise<"stored" | Error> {
  return schema
    .instance()
    .table(tableId)
    .insert(item)
    .run()
    .then(
      () => "stored" as const,
      (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
    );
}

/** The schema's tables without indexes, `items` holding one row. */
async function Fresh(schemaId: string): Promise<void> {
  for (const tableId of ["items", "others"]) {
    await Run(
      sql`DROP TABLE IF EXISTS ${ident(PhysicalTable(schemaId, tableId))}`,
    );
  }
  await Schemas.register(schemaId, BARE);
  await WaitForIndexes(schemaId);
  await Run(
    sql`INSERT INTO ${ident(PhysicalTable(schemaId))} (_id, _instance, price) VALUES ('seed', '', 1)`,
  );
}

/** An open transaction that has read `items`, which holds off any `ALTER` on it until it ends. */
async function HoldTable(schemaId: string): Promise<PoolConnection> {
  const connection = await AcquireConnection();
  await Run(sql`START TRANSACTION`, connection);
  await Read(
    sql`SELECT _id FROM ${ident(PhysicalTable(schemaId))} LIMIT 1`,
    connection,
  );
  return connection;
}

async function Release(connection: PoolConnection): Promise<void> {
  await Run(sql`COMMIT`, connection);
  connection.release();
}

async function IndexNames(
  schemaId: string,
  tableId: TableId = "items",
): Promise<string[]> {
  const rows = await Read(
    sql`SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${param(PhysicalTable(schemaId, tableId))} AND INDEX_NAME <> 'PRIMARY' ORDER BY INDEX_NAME`,
  );
  return rows.map((row) => String(row.get("name")));
}

/** Whether a statement altering `items` is running on the server right now. */
async function IsAltering(schemaId: string): Promise<boolean> {
  const pattern = `ALTER TABLE \`${PhysicalTable(schemaId)}\`%`;
  const rows = await Read(
    sql`SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE ${param(pattern)}`,
  );
  return rows.length > 0;
}

/** How many polls over `ms` found `items` being altered. */
async function AlteringPolls(schemaId: string, ms: number): Promise<number> {
  let found = 0;
  for (const end = Date.now() + ms; Date.now() < end;) {
    found += Number(await IsAltering(schemaId));
    await delay(POLL_MS);
  }
  return found;
}

async function Stored(price: number): Promise<number> {
  const rows = await Read(
    sql`SELECT COUNT(*) AS n FROM ${ident(PhysicalTable(SCHEMA_ID))} WHERE price = ${param(price)}`,
  );
  return Number(rows[0]?.get("n"));
}

describe("a unique index whose build a long transaction holds off", function () {
  this.timeout(180_000);

  after(() => {
    Schemas.unregister(SCHEMA_ID);
    Schemas.unregister(GONE_ID);
  });

  it("refuses inserts by name while held, then is built once the transaction ends and refuses the duplicate", async () => {
    await Fresh(SCHEMA_ID);
    const held = await HoldTable(SCHEMA_ID);
    await Schemas.register(SCHEMA_ID, UNIQUE_PRICE);
    const read = schema.instance().table("items").get("seed").run();
    expect(
      await SettlesWithin(read, READ_MS),
      "reads go on while the build waits",
    ).to.equal(true);
    const whileHeld = Inserting("items", { _id: "held", price: 7 });
    const elsewhere = Inserting("others", { _id: "free", price: 7 });
    const settled = await SettlesWithin(whileHeld, PAST_GIVING_UP_MS);
    const others = await IndexNames(SCHEMA_ID, "others");
    await delay(LATER_PASS_MS);
    const later = await Inserting("items", { _id: "later", price: 8 });
    await Release(held);
    expect(settled, "the insert is answered while the table is held").to.equal(
      true,
    );
    const refusal = await whileHeld;
    expect(refusal, "the insert is refused").to.be.instanceOf(Error);
    expect(refusal === "stored" ? "" : refusal.message).to.include(
      `unique index 'price' on '${SCHEMA_ID}.items' is not built, because a transaction holds the table`,
    );
    expect(later, "a later pass keeps the refusal").to.be.instanceOf(Error);
    expect(await elsewhere, "a table nothing holds takes writes").to.equal(
      "stored",
    );
    expect(others, "a table nothing holds gets its index").to.deep.equal([
      "price",
    ]);
    expect(
      await SettlesWithin(WaitForIndexes(SCHEMA_ID), BUILT_MS),
      "the phase builds the index once the transaction ends",
    ).to.equal(true);
    expect(await IndexNames(SCHEMA_ID)).to.deep.equal(["price"]);
    expect(await Inserting("items", { _id: "first", price: 7 })).to.equal(
      "stored",
    );
    expect(
      IsDuplicateKeyError(
        await Inserting("items", { _id: "second", price: 7 }),
      ),
      "the duplicate is refused",
    ).to.equal(true);
    expect(await Stored(7)).to.equal(1);
  });

  it("stops trying once the schema is unregistered, and builds nothing for it", async () => {
    await Fresh(GONE_ID);
    const held = await HoldTable(GONE_ID);
    await Schemas.register(GONE_ID, UNIQUE_PRICE);
    expect(
      await AlteringPolls(GONE_ID, NEXT_ATTEMPT_MS),
      "the build waits on the transaction",
    ).to.be.above(0);
    Schemas.unregister(GONE_ID);
    await delay(SETTLE_MS);
    const polls = await AlteringPolls(GONE_ID, NEXT_ATTEMPT_MS);
    await Release(held);
    await delay(NEXT_ATTEMPT_MS);
    expect(polls, "no build runs once the schema is gone").to.equal(0);
    expect(await IndexNames(GONE_ID)).to.deep.equal([]);
  });
});
