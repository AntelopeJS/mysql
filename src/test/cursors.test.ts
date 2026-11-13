import { expect } from "chai";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { Schema } from "@antelopejs/interface-database/schema";
import type { SchemaDefinition } from "@antelopejs/interface-database/schema";

import { ident, int, param, sql } from "../statement";
import { AcquireConnection, Read } from "../connection";
import { GetOptions, type Options } from "../config";
import { SessionOf } from "../implementations/database/locks";
import { CountOpenCursors } from "../implementations/database/cursors";
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

type ItemsTable = ReturnType<ReturnType<Schema<Tables>["instance"]>["table"]>;

const MEGABYTE = 1024 * 1024;
const BATCH = 100;
/**
 * The idle reclaim of the DDL tests, well past the wait for the \`ALTER\` to block: a cursor reclaimed
 * before the server shows the \`ALTER\` waiting would release its lock early.
 */
const IDLE_MS = 4000;
/** How early a timer may fire against `Date.now()`, both rounding to the millisecond. */
const TIMER_ROUNDING_MS = 1;
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
  await schema.instance().table("items").get("absent").run();
  const places = String(rows).length;
  await Run(
    sql`INSERT INTO ${ident(PhysicalTable(schemaId, "items"))} (_id, _instance, n, pad, _extra) SELECT LPAD(n, ${param(places)}, '0'), '', n, REPEAT('x', ${param(padding)}), JSON_OBJECT() FROM ${Numbers(places)} AS numbers WHERE n < ${param(rows)}`,
  );
  return schema;
}

/**
 * One schema over a table whose cursor keeps its statement running on the server while it waits.
 *
 * A paused statement still sends until the socket buffers between the server and the client are
 * full, then ends and gives up its metadata lock once the rest of its result fits in them. Over
 * the two loopback hops of a published Docker port, stock Linux buffers take up to about 20 MB;
 * this table holds about 48 MB.
 */
function SeededPastSocketBuffers(schemaId: string): Promise<Schema<Tables>> {
  return Seeded(schemaId, 16_000, 3000);
}

/** The options the live adapter runs with now, with `overrides` on top, connected again. */
async function Reconnected(overrides: Options): Promise<Options> {
  const saved = GetOptions();
  await Reconnect({ ...saved, ...overrides });
  return saved;
}

async function UntilWaitingOnLock(table: string): Promise<void> {
  const pattern = `ALTER TABLE \`${table}\`%`;
  for (let attempt = 0; attempt < COMPLETES_WITHIN_MS / POLL_MS; attempt += 1) {
    const rows = await Read(
      sql`SELECT STATE AS state FROM information_schema.PROCESSLIST WHERE INFO LIKE ${param(pattern)}`,
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
    sql`SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE ${param(pattern)} AND INFO NOT LIKE '%PROCESSLIST%'`,
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

/** Ends, server-side, the connection that streams the table's rows to a cursor. */
async function KillStreaming(table: string): Promise<void> {
  const pattern = `SELECT %${table}%`;
  const rows = await Read(
    sql`SELECT ID AS id FROM information_schema.PROCESSLIST WHERE INFO LIKE ${param(pattern)} AND INFO NOT LIKE '%PROCESSLIST%'`,
  );
  expect(rows, "one connection streams the table").to.have.length(1);
  await Run(sql`KILL ${int(Number(rows[0].get("id")))}`);
}

/** Reads on until a read answers no row, and says how that read ended, or `pending` after `ms`. */
async function Ending(cursor: AsyncIterator<Item>, ms: number) {
  const late = delay(ms).then(() => "pending");
  for (;;) {
    const step = cursor.next().then(
      (result) => (result.done ? "done" : "row"),
      (err: unknown) => `rejected: ${String(err)}`,
    );
    const outcome = await Promise.race([step, late]);
    if (outcome !== "row") {
      return outcome;
    }
  }
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
    await Reconnect(restore);
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
    const everything = await table.run();
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
  let restore: Options;

  before(async () => {
    restore = await Reconnected({
      cursorBatchSize: BATCH,
      cursorIdleTimeoutMs: IDLE_MS,
    });
  });

  after(async () => {
    await Reconnect(restore);
  });

  it("waits while the cursor is open, and completes once the cursor is closed", async () => {
    const schemaId = "cursors_ddl_closed";
    const physical = PhysicalTable(schemaId, "items");
    const items = (await SeededPastSocketBuffers(schemaId))
      .instance()
      .table("items");
    const cursor = items[Symbol.asyncIterator]();
    expect((await cursor.next()).done).to.equal(false);
    const connection = await AcquireConnection();
    const altering = SessionOf(connection).apply(
      sql`ALTER TABLE ${ident(physical)} ADD COLUMN added INT`,
    );
    await UntilWaitingOnLock(physical);
    expect(
      await StreamingStatements(physical),
      "the cursor's statement holds the table",
    ).to.equal(1);
    await cursor.return?.();
    expect(CountOpenCursors(), "the close gave its connection back").to.equal(
      0,
    );
    await altering;
    connection.release();
    expect(await Columns(physical)).to.include("added");
    Schemas.unregister(schemaId);
  });

  it("waits while the cursor is open, and completes once the idle reclaim ends it", async () => {
    const schemaId = "cursors_ddl_reclaimed";
    const physical = PhysicalTable(schemaId, "items");
    const items = (await SeededPastSocketBuffers(schemaId))
      .instance()
      .table("items");
    const cursor = items[Symbol.asyncIterator]();
    const started = Date.now();
    expect((await cursor.next()).done).to.equal(false);
    const altered: SchemaDefinition = {
      items: {
        fields: { n: "number", pad: "string", added: "number" },
        indexes: {},
      },
    };
    const registering = Schemas.register(schemaId, altered);
    await UntilWaitingOnLock(physical);
    expect(
      await StreamingStatements(physical),
      "the cursor's statement holds the table",
    ).to.equal(1);
    await registering;
    expect(
      Date.now() - started,
      "the reclaim waited for cursorIdleTimeoutMs",
    ).to.be.at.least(IDLE_MS - TIMER_ROUNDING_MS);
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
    items = (await SeededPastSocketBuffers(schemaId)).instance().table("items");
  });

  after(async () => {
    Schemas.unregister(schemaId);
    await Reconnect(restore);
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
    items = (await SeededPastSocketBuffers(schemaId)).instance().table("items");
  });

  after(async () => {
    Schemas.unregister(schemaId);
    await Reconnect(restore);
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

describe("a cursor whose connection the server ends", function () {
  this.timeout(120_000);
  const schemaId = "cursors_killed";
  let restore: Options;
  let items: ItemsTable;

  before(async () => {
    restore = await Reconnected({ maxOpenCursors: 1, cursorBatchSize: BATCH });
    items = (await SeededPastSocketBuffers(schemaId)).instance().table("items");
  });

  after(async () => {
    Schemas.unregister(schemaId);
    await Reconnect(restore);
  });

  /**
   * A read that waited on a stream its connection no longer feeds would never settle, and the
   * cursor would hold the only place `maxOpenCursors: 1` allows for good.
   */
  it("rejects the read that meets the lost connection, and frees its place under the cap", async () => {
    const cursor = items[Symbol.asyncIterator]();
    for (let row = 0; row < 10; row += 1) {
      expect((await cursor.next()).done).to.equal(false);
    }
    await KillStreaming(PhysicalTable(schemaId, "items"));
    expect(await Ending(cursor, COMPLETES_WITHIN_MS)).to.match(/^rejected: /);
    await cursor.return?.();
    expect(CountOpenCursors()).to.equal(0);
    for await (const row of items) {
      expect(row.n).to.equal(0);
      break;
    }
  });
});
