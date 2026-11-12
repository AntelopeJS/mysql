import { expect } from "chai";
import type { PoolConnection } from "mysql2/promise";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "@antelopejs/interface-database/schema";
import type { SchemaDefinition } from "@antelopejs/interface-database/schema";

import { ident, param, sql } from "../statement";
import { AcquireConnection, Read } from "../connection";
import { GetOptions, type Options } from "../config";
import { Schemas } from "../implementations/database/schema";
import { Numbers, PhysicalTable, Reconnect, Run } from "./tables";

interface Item {
  _id: string;
  n: number;
  pad: string;
}

interface Tables {
  items: Item;
}

const DEFINITION: SchemaDefinition = {
  items: { fields: { n: "number", pad: "string" }, indexes: {} },
};

const SCHEMA_ID = "cursors_timeout";
const ROWS = 20_000;
const PADDING = 1000;
const BATCH = 100;
const CAP_MS = 500;
const SLOW_READER_MS = 1500;
const CONNECTIONS = 2;

async function Seeded(): Promise<Schema<Tables>> {
  const schema = new Schema<Tables>(SCHEMA_ID, DEFINITION);
  await schema.instance().table("items").get("absent");
  const places = String(ROWS).length;
  await Run(
    sql`INSERT INTO ${ident(PhysicalTable(SCHEMA_ID, "items"))} (_id, _instance, n, pad, _extra) SELECT LPAD(n, ${param(places)}, '0'), '', n, REPEAT('x', ${param(PADDING)}), JSON_OBJECT() FROM ${Numbers(places)} AS numbers WHERE n < ${param(ROWS)}`,
  );
  return schema;
}

async function Cap(connection?: PoolConnection) {
  const statement = sql`SELECT @@SESSION.max_execution_time AS cap`;
  const [row] = await Read(statement, connection);
  return Number(row.get("cap"));
}

describe("a cursor under statementTimeoutMs", function () {
  this.timeout(120_000);
  let restore: Options;
  let items: ReturnType<ReturnType<Schema<Tables>["instance"]>["table"]>;

  before(async () => {
    restore = GetOptions();
    await Reconnect({
      ...restore,
      statementTimeoutMs: CAP_MS,
      cursorBatchSize: BATCH,
      maxOpenCursors: 1,
      pool: { ...restore.pool, connectionLimit: CONNECTIONS },
    });
    items = (await Seeded()).instance().table("items");
  });

  after(async () => {
    Schemas.unregister(SCHEMA_ID);
    await Reconnect(restore);
  });

  it("reads every row though its reader takes longer than the cap between batches", async () => {
    const cursor = items[Symbol.asyncIterator]();
    expect((await cursor.next()).done).to.equal(false);
    await delay(SLOW_READER_MS);
    let rows = 1;
    for (
      let next = await cursor.next();
      !next.done;
      next = await cursor.next()
    ) {
      rows += 1;
    }
    expect(rows).to.equal(ROWS);
  });

  it("gives its connection back to the pool with the cap restored", async () => {
    const held = await Promise.all(
      Array.from({ length: CONNECTIONS }, () => AcquireConnection()),
    );
    const caps = await Promise.all(held.map((connection) => Cap(connection)));
    for (const connection of held) {
      connection.release();
    }
    expect(caps).to.deep.equal(Array(CONNECTIONS).fill(CAP_MS));
  });

  it("keeps the cap on a pooled read", async () => {
    expect(await Cap()).to.equal(CAP_MS);
  });
});
