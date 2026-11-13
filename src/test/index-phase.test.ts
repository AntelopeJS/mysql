import { expect } from "chai";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Connection,
  type PoolConnection,
  type RowDataPacket,
  createConnection,
} from "mysql2/promise";
import { IsDuplicateKeyError } from "@antelopejs/interface-database";
import {
  Schema,
  type SchemaDefinition,
} from "@antelopejs/interface-database/schema";

import { Bind, type Sql, ident, param, sql } from "../statement";
import { GetOptions, type ResolvedOptions } from "../config";
import {
  AcquireConnection,
  GetDialect,
  Read,
  RegisterBeforeDisconnect,
} from "../connection";
import {
  FailureOf,
  Interrupt,
  SessionOf,
} from "../implementations/database/locks";
import { ConvergeIndexes } from "../implementations/database/migrate-indexes";
import { SchemaKey } from "../implementations/database/registry";
import {
  GetTablePlan,
  Schemas,
  WaitForIndexes,
  WaitForSchemaReady,
  WaitForUniqueIndexes,
} from "../implementations/database/schema";
import { Numbers, PhysicalTable, Reconnect, Run } from "./tables";
import { SettlesWithin } from "./watch";

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
const UNIQUE_PRICE_AND_SKU: SchemaDefinition = {
  items: { fields: FIELDS, indexes: { price: { unique: true }, sku: {} } },
};

interface Item {
  _id?: string;
  sku?: string;
  price?: number;
}

const LARGE_ROWS = 600_000;
const POLL_MS = 5;
const POLL_ATTEMPTS = 2000;
const BLOCKED_MS = 300;

/** Longer than a tables phase takes to take its lock once another process gives it up. */
const SLOW_DISCONNECT_MS = 3000;

/**
 * How long a write that does not wait for the index phase may take, its schema's convergence
 * included. The phase stays held throughout, so a write that waited for it would never settle.
 */
const PROMPT_MS = 10_000;

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
  const pattern = `ALTER TABLE \`${PhysicalTable(schemaId)}\` ADD %INDEX%`;
  const rows = await Read(
    sql`SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE ${param(pattern)}`,
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

function Track(promise: Promise<unknown>): Settling {
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

/** The statement that takes the schema's lock of a phase at once, as another process's phase does. */
async function TakePhaseLock(
  schemaId: string,
  phase: "tables" | "indexes",
): Promise<Sql> {
  const dialect = GetDialect();
  const [database] = await Read(dialect.catalog.readDatabase());
  const name = dialect.session.lockName(
    phase,
    `${String(database?.get("name"))}/${SchemaKey(schemaId)}`,
  );
  return dialect.session.acquireLock(name, 0);
}

/**
 * A connection holding the schema's index-phase lock, as another process's index phase holds it
 * while it builds.
 */
async function HoldIndexPhase(schemaId: string): Promise<PoolConnection> {
  const take = await TakePhaseLock(schemaId, "indexes");
  const connection = await AcquireConnection();
  const [held] = await Read(take, connection);
  expect(Number(held?.get("acquired")), "the lock is free to take").to.equal(1);
  return connection;
}

/** A connection of another process, outside this one's pool, holding the lock of a phase of each schema. */
async function HoldIndexPhasesElsewhere(
  url: string,
  schemaIds: readonly string[],
  phase: "tables" | "indexes" = "indexes",
): Promise<Connection> {
  const elsewhere = await createConnection(url);
  for (const schemaId of schemaIds) {
    const take = Bind(await TakePhaseLock(schemaId, phase));
    const [rows] = await elsewhere.query<RowDataPacket[]>(take.sql, [
      ...take.args,
    ]);
    expect(Number(rows[0]?.acquired), "the lock is free to take").to.equal(1);
  }
  return elsewhere;
}

/** An open transaction of another process that has read the table, which holds off any `ALTER` on it. */
async function HoldTableElsewhere(
  url: string,
  schemaId: string,
): Promise<Connection> {
  const elsewhere = await createConnection(url);
  await elsewhere.query("START TRANSACTION");
  await elsewhere.query(
    Bind(sql`SELECT _id FROM ${ident(PhysicalTable(schemaId))} LIMIT 1`).sql,
  );
  return elsewhere;
}

async function ReleaseIndexPhase(connection: PoolConnection): Promise<void> {
  await Run(sql`DO RELEASE_ALL_LOCKS()`, connection);
  connection.release();
}

/** Starts the insert at once, settled to `"stored"` or to the error it threw. */
function Inserting(schema: Schema<{ items: Item }>, item: Item) {
  return schema
    .instance()
    .table("items")
    .insert(item)
    .run()
    .then(
      () => "stored" as const,
      (err: unknown) => err,
    );
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
    const stop = new AbortController();
    const plan = GetTablePlan(schemaId, "items");
    const phase = ConvergeIndexes(session, plan, stop.signal).then(
      () => undefined,
      (err: unknown) => FailureOf(err),
    );
    await UntilBuilding(schemaId);
    stop.abort();
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
    Schemas.unregister("index_phase_elsewhere");
    Schemas.unregister("index_phase_built");
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

  it("holds writes while another process builds the unique index, then refuses the duplicate", async () => {
    const schemaId = "index_phase_elsewhere";
    await Fresh(schemaId, 100);
    const elsewhere = await HoldIndexPhase(schemaId);
    const schema = new Schema<{ items: Item }>(schemaId, UNIQUE_PRICE);
    const insert = Inserting(schema, {
      _id: "duplicate",
      price: 7,
    });
    const isHeld = !(await SettlesWithin(insert, BLOCKED_MS));
    await ReleaseIndexPhase(elsewhere);
    expect(isHeld, "the write waits for the other process's build").to.equal(
      true,
    );
    expect(IsDuplicateKeyError(await insert)).to.equal(true);
    expect(await IndexNames(schemaId)).to.deep.equal(["price"]);
  });

  it("lets writes through while another process holds the index phase, once the unique index exists", async () => {
    const schemaId = "index_phase_built";
    await Fresh(schemaId, 100);
    await Schemas.register(schemaId, UNIQUE_PRICE);
    await WaitForIndexes(schemaId);
    const elsewhere = await HoldIndexPhase(schemaId);
    const schema = new Schema<{ items: Item }>(schemaId, UNIQUE_PRICE_AND_SKU);
    const stored = Inserting(schema, { _id: "new", price: 1000 });
    const duplicate = Inserting(schema, { _id: "duplicate", price: 7 });
    const isPrompt = await SettlesWithin(stored, PROMPT_MS);
    await ReleaseIndexPhase(elsewhere);
    expect(isPrompt, "the write does not wait for the other build").to.equal(
      true,
    );
    expect(await stored).to.equal("stored");
    expect(IsDuplicateKeyError(await duplicate)).to.equal(true);
    await WaitForIndexes(schemaId);
    expect(await IndexNames(schemaId)).to.deep.equal(["price", "sku"]);
  });
});

describe("index phases waiting for another process's builds", function () {
  this.timeout(60_000);
  const reader = "index_phase_reader";
  const waiting = ["index_phase_waiting_a", "index_phase_waiting_b"];
  let restore: ResolvedOptions;

  before(async () => {
    for (const schemaId of [reader, ...waiting]) {
      await Fresh(schemaId, 1);
    }
    restore = GetOptions();
    await Reconnect({
      ...restore,
      pool: { ...restore.pool, connectionLimit: waiting.length },
    });
  });

  after(async () => {
    for (const schemaId of [reader, ...waiting]) {
      Schemas.unregister(schemaId);
    }
    await Reconnect(restore);
  });

  it("hold no pooled connection while they wait, so a read of another schema runs", async () => {
    const items = new Schema<{ items: Item }>(reader, BARE)
      .instance()
      .table("items");
    await WaitForIndexes(reader);
    const elsewhere = await HoldIndexPhasesElsewhere(restore.url, waiting);
    try {
      for (const schemaId of waiting) {
        await Schemas.register(schemaId, PRICED);
      }
      await delay(BLOCKED_MS);
      const read = items.get("0000000").run();
      expect(
        await SettlesWithin(read, BLOCKED_MS * 10),
        "the read is not queued behind the waiting index phases",
      ).to.equal(true);
      expect((await read)?.sku).to.equal("sku-0");
    } finally {
      await elsewhere.end();
    }
    for (const schemaId of waiting) {
      await WaitForIndexes(schemaId);
      expect(await IndexNames(schemaId), schemaId).to.deep.equal(["price"]);
    }
  });
});

/**
 * Fails on an index phase that a reconnect stops while it builds a unique index or waits for
 * another process's phase, and is then never run on the next pool, so the duplicate is stored; and
 * on a stop that opens the unique-index gate, so a write held there stores its duplicate on the pool
 * being ended while the disconnect still waits on another connection, such as a cursor's; and on a
 * phase that starts on that pool after the stop, fails there, and is then never run again.
 */
describe("an index phase a reconnect stops", function () {
  this.timeout(60_000);
  const running = "index_phase_reconnect_running";
  const queued = "index_phase_reconnect_queued";
  const held = "index_phase_reconnect_held";
  const late = "index_phase_reconnect_late";
  const duplicate: Item = { _id: "duplicate", price: 7 };

  after(() => {
    for (const schemaId of [running, queued, held, late]) {
      Schemas.unregister(schemaId);
    }
  });

  it("builds the unique index on the next pool when the reconnect killed its build, and refuses the duplicate", async () => {
    await Fresh(running, 100);
    const restore = GetOptions();
    const elsewhere = await HoldTableElsewhere(restore.url, running);
    const schema = new Schema<{ items: Item }>(running, UNIQUE_PRICE);
    try {
      await UntilBuilding(running);
      await Reconnect(restore);
    } finally {
      await elsewhere.end();
    }
    expect(await Inserting(schema, duplicate)).to.satisfy(
      IsDuplicateKeyError,
      "the duplicate is refused",
    );
    expect(await IndexNames(running)).to.deep.equal(["price"]);
  });

  it("builds the unique index on the next pool when the reconnect stopped it waiting for another process's phase, and refuses the duplicate", async () => {
    await Fresh(queued, 100);
    const restore = GetOptions();
    const elsewhere = await HoldIndexPhasesElsewhere(restore.url, [queued]);
    const schema = new Schema<{ items: Item }>(queued, UNIQUE_PRICE);
    try {
      await WaitForSchemaReady(queued);
      await Reconnect(restore);
    } finally {
      await elsewhere.end();
    }
    expect(await Inserting(schema, duplicate)).to.satisfy(
      IsDuplicateKeyError,
      "the duplicate is refused",
    );
    expect(await IndexNames(queued)).to.deep.equal(["price"]);
  });

  it("refuses a write held for the unique index when the reconnect stops the phase, while the disconnect waits on another connection", async () => {
    await Fresh(held, 100);
    const restore = GetOptions();
    const elsewhere = await HoldIndexPhasesElsewhere(restore.url, [held]);
    const schema = new Schema<{ items: Item }>(held, UNIQUE_PRICE);
    const insert = Inserting(schema, duplicate);
    const withdraw = RegisterBeforeDisconnect(() => delay(BLOCKED_MS));
    try {
      expect(
        await SettlesWithin(insert, BLOCKED_MS),
        "the write waits for the unique index",
      ).to.equal(false);
      await Reconnect(restore);
    } finally {
      withdraw();
      await elsewhere.end();
    }
    expect(await insert).to.not.equal("stored");
    await WaitForIndexes(held);
    expect(await IndexNames(held)).to.deep.equal(["price"]);
  });

  it("builds the unique index on the next pool when the phase would start while the disconnect waits on another connection, and refuses the duplicate", async () => {
    await Fresh(late, 100);
    const restore = GetOptions();
    const tables = await HoldIndexPhasesElsewhere(
      restore.url,
      [late],
      "tables",
    );
    const table = await HoldTableElsewhere(restore.url, late);
    const schema = new Schema<{ items: Item }>(late, UNIQUE_PRICE);
    const withdraw = RegisterBeforeDisconnect(() => delay(SLOW_DISCONNECT_MS));
    try {
      const reconnecting = Reconnect(restore);
      await tables.end();
      await reconnecting;
    } finally {
      withdraw();
      await table.end();
    }
    expect(await Inserting(schema, duplicate)).to.satisfy(
      IsDuplicateKeyError,
      "the duplicate is refused",
    );
    expect(await IndexNames(late)).to.deep.equal(["price"]);
  });
});
