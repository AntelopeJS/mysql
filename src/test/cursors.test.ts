import { expect } from "chai";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { Schema } from "@antelopejs/interface-database/schema";
import type { SchemaDefinition } from "@antelopejs/interface-database/schema";

import { ident, param, sql } from "../statement";
import { AcquireConnection, Connect, Read } from "../connection";
import { GetOptions, type Options } from "../config";
import { SessionOf } from "../implementations/database/locks";
import { CountOpenCursors } from "../implementations/database/cursors";
import { Schemas } from "../implementations/database/schema";
import { Numbers, PhysicalTable, Run } from "./tables";

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

type ItemsTable = ReturnType<ReturnType<Schema<Tables>["instance"]>["table"]>;

const MEGABYTE = 1024 * 1024;
const BATCH = 100;
const IDLE_MS = 1500;
const BLOCKED_MS = 1200;
const COMPLETES_WITHIN_MS = 15_000;
const SAMPLE_EVERY = 2000;
const STALL_MS = 1000;
const POLL_MS = 20;

setFlagsFromString("--expose-gc");

/** Heap and buffers still reachable after a full collection: what the process holds, not what it garbaged. */
function Retained(): number {
  runInNewContext("gc()");
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

/** One schema over a table of `rows` rows, each `padding` characters wide, in the default instance. */
async function Seeded(
  schemaId: string,
  rows: number,
  padding: number,
): Promise<Schema<Tables>> {
  const schema = new Schema<Tables>(schemaId, DEFINITION);
  await schema.instance().table("items").get("absent");
  const places = String(rows).length;
  await Run(
    sql`INSERT INTO ${ident(PhysicalTable(schemaId, "items"))} (_id, _instance, n, pad, _extra) SELECT LPAD(n, ${param(places)}, '0'), '', n, REPEAT('x', ${param(padding)}), JSON_OBJECT() FROM ${Numbers(places)} AS numbers WHERE n < ${param(rows)}`,
  );
  return schema;
}

/** The options the live adapter runs with now, with `overrides` on top, connected again. */
async function Reconnected(overrides: Options): Promise<Options> {
  const saved = GetOptions();
  await Connect({ ...saved, ...overrides });
  return saved;
}

async function UntilWaitingOnLock(table: string): Promise<void> {
  const pattern = `ALTER TABLE \`${table}\`%`;
  for (let attempt = 0; attempt < COMPLETES_WITHIN_MS / POLL_MS; attempt += 1) {
    const rows = await Read(
      sql`SELECT STATE AS state FROM performance_schema.processlist WHERE INFO LIKE ${param(pattern)}`,
    );
    if (
      rows.some((row) => row.get("state") === "Waiting for table metadata lock")
    ) {
      return;
    }
    await delay(POLL_MS);
  }
  expect.fail("the ALTER never waited on the metadata lock");
}

async function StreamingStatements(table: string): Promise<number> {
  const pattern = `SELECT %${table}%`;
  const rows = await Read(
    sql`SELECT ID FROM performance_schema.processlist WHERE INFO LIKE ${param(pattern)} AND INFO NOT LIKE '%processlist%'`,
  );
  return rows.length;
}

/** The server aborts a statement when its socket closes, a moment after the client destroyed it. */
async function UntilNoneStreaming(table: string): Promise<void> {
  for (let attempt = 0; attempt < COMPLETES_WITHIN_MS / POLL_MS; attempt += 1) {
    if ((await StreamingStatements(table)) === 0) {
      return;
    }
    await delay(POLL_MS);
  }
  expect.fail("the server still streams a statement nothing reads");
}

async function Columns(table: string): Promise<string[]> {
  const rows = await Read(
    sql`SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${param(table)} ORDER BY ORDINAL_POSITION`,
  );
  return rows.map((row) => String(row.get("name")));
}

describe("a cursor over a large result", function () {
  this.timeout(180_000);
  const schemaId = "cursors_memory";
  const ROWS = 100_000;
  const PADDING = 400;
  let restore: Options;
  let table: ItemsTable;

  before(async () => {
    restore = await Reconnected({
      cursorBatchSize: BATCH,
      cursorIdleTimeoutMs: STALL_MS * 30,
    });
    table = (await Seeded(schemaId, ROWS, PADDING)).instance().table("items");
  });

  after(async () => {
    Schemas.unregister(schemaId);
    await Connect(restore);
  });

  /**
   * The server produces rows about as fast as a loop consumes them, so a loop that never waits
   * would not tell a bounded buffer from an unbounded one. The consumer stalls for a second after
   * the first row and after the middle one, long enough for a stream with no bound to take the
   * whole result, which is what the control below measures.
   */
  it("holds about one batch of it while 100000 rows are iterated, not the result", async () => {
    const base = Retained();
    let peak = 0;
    let seen = 0;
    for await (const row of table) {
      expect(row.n).to.equal(seen);
      seen += 1;
      if (seen === 1 || seen === ROWS / 2) {
        await delay(STALL_MS);
        peak = Math.max(peak, Retained() - base);
      } else if (seen % SAMPLE_EVERY === 0) {
        peak = Math.max(peak, Retained() - base);
      }
    }
    expect(seen).to.equal(ROWS);
    console.log(
      `      retained at most ${(peak / MEGABYTE).toFixed(1)} MB over ${ROWS} rows of ${PADDING + 40} bytes`,
    );
    expect(peak).to.be.lessThan(8 * MEGABYTE);
    expect(CountOpenCursors()).to.equal(0);
  });

  it("is told apart from reading the result whole, which holds all of it", async () => {
    const base = Retained();
    const everything = await table;
    const held = Retained() - base;
    console.log(
      `      reading the result whole retains ${(held / MEGABYTE).toFixed(1)} MB`,
    );
    expect(everything).to.have.length(ROWS);
    expect(held).to.be.greaterThan(24 * MEGABYTE);
  });
});

describe("a DDL statement on a table with an open cursor", function () {
  this.timeout(180_000);
  const ROWS = 20_000;
  const PADDING = 1000;
  let restore: Options;

  before(async () => {
    restore = await Reconnected({
      cursorBatchSize: BATCH,
      cursorIdleTimeoutMs: IDLE_MS,
    });
  });

  after(async () => {
    await Connect(restore);
  });

  it("waits while the cursor is open, and completes once the cursor is closed", async () => {
    const schemaId = "cursors_ddl_closed";
    const physical = PhysicalTable(schemaId, "items");
    const items = (await Seeded(schemaId, ROWS, PADDING))
      .instance()
      .table("items");
    const cursor = items[Symbol.asyncIterator]();
    expect((await cursor.next()).done).to.equal(false);
    const connection = await AcquireConnection();
    let isAltered = false;
    const altering = SessionOf(connection)
      .apply(sql`ALTER TABLE ${ident(physical)} ADD COLUMN added INT`)
      .then(() => {
        isAltered = true;
      });
    await UntilWaitingOnLock(physical);
    await delay(BLOCKED_MS);
    expect(isAltered, "the ALTER finished under an open cursor").to.equal(
      false,
    );
    await cursor.return?.();
    await altering;
    connection.release();
    expect(await Columns(physical)).to.include("added");
    Schemas.unregister(schemaId);
  });

  it("waits while the cursor is open, and completes once the idle reclaim ends it", async () => {
    const schemaId = "cursors_ddl_reclaimed";
    const physical = PhysicalTable(schemaId, "items");
    const items = (await Seeded(schemaId, ROWS, PADDING))
      .instance()
      .table("items");
    const cursor = items[Symbol.asyncIterator]();
    expect((await cursor.next()).done).to.equal(false);
    const altered: SchemaDefinition = {
      items: {
        fields: { n: "number", pad: "string", added: "number" },
        indexes: {},
      },
    };
    const started = Date.now();
    await Schemas.register(schemaId, altered);
    expect(Date.now() - started).to.be.greaterThan(IDLE_MS / 2);
    expect(await Columns(physical)).to.include("added");
    let failure = "";
    try {
      await cursor.next();
    } catch (err) {
      failure = String(err);
    }
    expect(failure).to.contain("cursorIdleTimeoutMs");
    Schemas.unregister(schemaId);
  });
});

describe("the cap on open cursors", function () {
  this.timeout(120_000);
  const schemaId = "cursors_cap";
  let restore: Options;
  let items: ItemsTable;

  before(async () => {
    restore = await Reconnected({ maxOpenCursors: 2, cursorBatchSize: BATCH });
    items = (await Seeded(schemaId, 20_000, 1000)).instance().table("items");
  });

  after(async () => {
    Schemas.unregister(schemaId);
    await Connect(restore);
  });

  /**
   * A cap that is only a count in the registry, and takes the connection anyway, would open the
   * third cursor: it is refused before any connection is taken, which the statements the server
   * is streaming show.
   */
  it("refuses the cursor past maxOpenCursors, naming the setting, and serves the others", async () => {
    const first = items[Symbol.asyncIterator]();
    const second = items[Symbol.asyncIterator]();
    const third = items[Symbol.asyncIterator]();
    expect((await first.next()).done).to.equal(false);
    expect((await second.next()).done).to.equal(false);
    let refusal = "";
    try {
      await third.next();
    } catch (err) {
      refusal = String(err);
    }
    expect(refusal).to.contain("maxOpenCursors");
    expect(CountOpenCursors()).to.equal(2);
    expect(
      await StreamingStatements(PhysicalTable(schemaId, "items")),
    ).to.equal(2);
    expect((await first.next()).done).to.equal(false);
    await first.return?.();
    const later = items[Symbol.asyncIterator]();
    expect((await later.next()).done).to.equal(false);
    await later.return?.();
    await second.return?.();
    await third.return?.();
    expect(CountOpenCursors()).to.equal(0);
  });

  it("leaves the pool free for ordinary statements while the cap is reached", async () => {
    const first = items[Symbol.asyncIterator]();
    const second = items[Symbol.asyncIterator]();
    await first.next();
    await second.next();
    const rows = await Read(sql`SELECT 1 AS one`);
    expect(rows).to.have.length(1);
    await first.return?.();
    await second.return?.();
  });
});

describe("leaving a for-await early", function () {
  this.timeout(120_000);
  const schemaId = "cursors_return";
  let restore: Options;
  let items: ItemsTable;

  before(async () => {
    restore = await Reconnected({
      maxOpenCursors: 1,
      pool: { connectionLimit: 2 },
    });
    items = (await Seeded(schemaId, 20_000, 1000)).instance().table("items");
  });

  after(async () => {
    Schemas.unregister(schemaId);
    await Connect(restore);
  });

  /**
   * A cursor that kept its connection after `return()` would hold the only place `maxOpenCursors: 1`
   * allows, so the second iteration would be refused, and the server would still show the
   * statement streaming.
   */
  it("releases the connection, so the next cursor opens and the statement is gone from the server", async () => {
    for (let round = 0; round < 5; round += 1) {
      for await (const row of items) {
        expect(row.n).to.equal(0);
        break;
      }
      expect(CountOpenCursors()).to.equal(0);
    }
    const physical = PhysicalTable(schemaId, "items");
    await UntilNoneStreaming(physical);
  });

  it("releases the connection when the loop body throws", async () => {
    let failure = "";
    try {
      for await (const row of items) {
        throw new Error(`stopped at ${row.n}`);
      }
    } catch (err) {
      failure = String(err);
    }
    expect(failure).to.contain("stopped at 0");
    expect(CountOpenCursors()).to.equal(0);
    for await (const row of items) {
      expect(row.n).to.equal(0);
      break;
    }
  });
});
