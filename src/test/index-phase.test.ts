import { expect } from "chai";
import { setTimeout as delay } from "node:timers/promises";
import type { PoolConnection } from "mysql2/promise";
import type { SchemaDefinition } from "@antelopejs/interface-database/schema";

import { ident, param, sql } from "../statement";
import { AcquireConnection, Read } from "../connection";
import {
  FailureOf,
  Interrupt,
  SessionOf,
} from "../implementations/database/locks";
import { ConvergeIndexes } from "../implementations/database/migrate-indexes";
import {
  GetTablePlan,
  Schemas,
  WaitForIndexes,
  WaitForUniqueIndexes,
} from "../implementations/database/schema";
import { Numbers, PhysicalTable, Run } from "./tables";

interface Settling {
  isSettled: boolean;
  readonly done: Promise<void>;
}

const FIELDS = { sku: "string", price: "number" } as const;
const BARE: SchemaDefinition = { items: { fields: FIELDS, indexes: {} } };
const COLORED: SchemaDefinition = {
  items: { fields: FIELDS, indexes: { color: {} } },
};

/** Indexes over a stored column, which need no key column: the tables phase has nothing to do. */
const PRICED: SchemaDefinition = {
  items: { fields: FIELDS, indexes: { price: {} } },
};
const UNIQUE_PRICE: SchemaDefinition = {
  items: { fields: FIELDS, indexes: { price: { unique: true } } },
};

const LARGE_ROWS = 600_000;
const POLL_MS = 5;
const POLL_ATTEMPTS = 2000;
const BLOCKED_MS = 300;

/** `rows` rows in the default instance, each with its own `sku` and `_extra.color`. */
async function Seed(schemaId: string, rows: number): Promise<void> {
  await Run(
    sql`INSERT INTO ${ident(PhysicalTable(schemaId))} (_id, _instance, sku, price, _extra) SELECT LPAD(n, 7, '0'), '', CONCAT('sku-', n), n, JSON_OBJECT('color', CONCAT('color-', n % 1000)) FROM ${Numbers(6)} AS numbers WHERE n < ${param(rows)}`,
  );
}

async function Fresh(schemaId: string, rows: number): Promise<void> {
  await Run(sql`DROP TABLE IF EXISTS ${ident(PhysicalTable(schemaId))}`);
  await Schemas.register(schemaId, BARE);
  await WaitForIndexes(schemaId);
  await Seed(schemaId, rows);
}

async function IndexNames(schemaId: string): Promise<string[]> {
  const rows = await Read(
    sql`SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${param(PhysicalTable(schemaId))} AND INDEX_NAME <> 'PRIMARY' ORDER BY INDEX_NAME`,
  );
  return rows.map((row) => String(row.get("name")));
}

/** Whether a statement adding an index to the table is running on the server right now. */
async function IsBuilding(schemaId: string): Promise<boolean> {
  const pattern = `ALTER TABLE \`${PhysicalTable(schemaId)}\` ADD INDEX%`;
  const rows = await Read(
    sql`SELECT ID FROM performance_schema.processlist WHERE INFO LIKE ${param(pattern)}`,
  );
  return rows.length > 0;
}

async function UntilBuilding(schemaId: string): Promise<void> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    if (await IsBuilding(schemaId)) {
      return;
    }
    await delay(POLL_MS);
  }
  expect.fail("the index build never started");
}

function Track(promise: Promise<void>): Settling {
  const settling: Settling = {
    isSettled: false,
    done: promise.then(() => {
      settling.isSettled = true;
    }),
  };
  return settling;
}

/** An open transaction that has read the table, which holds off any `ALTER` on it until it ends. */
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

describe("an index build on a large table", function () {
  this.timeout(120_000);
  const schemaId = "index_phase_online";

  before(async () => {
    await Fresh(schemaId, LARGE_ROWS);
  });

  after(() => {
    Schemas.unregister(schemaId);
  });

  it("keeps writes flowing while a btree index builds", async () => {
    await Schemas.register(schemaId, COLORED);
    await UntilBuilding(schemaId);
    await Run(
      sql`INSERT INTO ${ident(PhysicalTable(schemaId))} (_id, _instance, sku) VALUES ('written-during-build', '', 'late')`,
    );
    expect(await IsBuilding(schemaId), "the build outlived the write").to.equal(
      true,
    );
    await WaitForIndexes(schemaId);
    expect(await IndexNames(schemaId)).to.deep.equal(["color"]);
  });

  it("stops a running build when it is interrupted, leaving no index behind", async () => {
    await Run(
      sql`ALTER TABLE ${ident(PhysicalTable(schemaId))} DROP INDEX color`,
    );
    const connection = await AcquireConnection();
    const session = SessionOf(connection);
    let isStopping = false;
    const plan = GetTablePlan(schemaId, "items");
    const phase = ConvergeIndexes(session, plan, () => isStopping).then(
      () => undefined,
      (err: unknown) => FailureOf(err),
    );
    await UntilBuilding(schemaId);
    isStopping = true;
    await Interrupt(session);
    expect(await phase).to.equal("interrupted");
    connection.release();
    expect(await IndexNames(schemaId)).to.deep.equal([]);
  });
});

describe("the unique-index write gate", function () {
  this.timeout(60_000);

  afterEach(() => {
    Schemas.unregister("index_phase_plain");
    Schemas.unregister("index_phase_unique");
  });

  it("never holds writes to a schema whose new indexes are not unique", async () => {
    const schemaId = "index_phase_plain";
    await Fresh(schemaId, 100);
    const held = await HoldTable(schemaId);
    await Schemas.register(schemaId, PRICED);
    const indexing = Track(WaitForIndexes(schemaId));
    const gate = Track(WaitForUniqueIndexes(schemaId));
    await delay(BLOCKED_MS);
    expect(
      indexing.isSettled,
      "the index phase waits on the open transaction",
    ).to.equal(false);
    expect(gate.isSettled, "writes go ahead").to.equal(true);
    await Release(held);
    await indexing.done;
    expect(await IndexNames(schemaId)).to.deep.equal(["price"]);
  });

  it("holds writes to a schema until its unique indexes exist", async () => {
    const schemaId = "index_phase_unique";
    await Fresh(schemaId, 100);
    const held = await HoldTable(schemaId);
    await Schemas.register(schemaId, UNIQUE_PRICE);
    const gate = Track(WaitForUniqueIndexes(schemaId));
    await delay(BLOCKED_MS);
    expect(gate.isSettled, "writes wait for the unique index").to.equal(false);
    await Release(held);
    await gate.done;
    expect(await IndexNames(schemaId)).to.deep.equal(["price"]);
  });
});
