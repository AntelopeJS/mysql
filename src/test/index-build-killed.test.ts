import { expect } from "chai";
import { setTimeout as delay } from "node:timers/promises";
import { type PoolConnection, createConnection } from "mysql2/promise";
import { IsDuplicateKeyError } from "@antelopejs/interface-database";
import {
  Schema,
  type SchemaDefinition,
} from "@antelopejs/interface-database/schema";

import { type Sql, ident, int, lit, param, sql } from "../statement";
import { AcquireConnection, Read } from "../connection";
import { GetOptions } from "../config";
import { Logger } from "../logger";
import { Schemas, WaitForIndexes } from "../implementations/database/schema";
import { Numbers, PhysicalTable, Run } from "./tables";
import { SettlesWithin } from "./watch";

const FIELDS = { sku: "string", price: "number" } as const;
const BARE: SchemaDefinition = { items: { fields: FIELDS, indexes: {} } };
const UNIQUE_PRICE: SchemaDefinition = {
  items: { fields: FIELDS, indexes: { price: { unique: true } } },
};

interface Item {
  _id?: string;
  price?: number;
}

const ROWS = 100;
const POLL_MS = 5;
const POLL_ATTEMPTS = 2000;

/** Far longer than a phase that ends at once takes; a phase that tried a refusal again would never end. */
const PROMPT_MS = 10_000;

/** A table of `ROWS` rows with distinct prices, and no index but its primary key. */
async function Fresh(schemaId: string): Promise<void> {
  const table = ident(PhysicalTable(schemaId));
  await Run(sql`DROP TABLE IF EXISTS ${table}`);
  await Schemas.register(schemaId, BARE);
  await WaitForIndexes(schemaId);
  Schemas.unregister(schemaId);
  await Run(
    sql`INSERT INTO ${table} (_id, _instance, sku, price) SELECT LPAD(n, 7, '0'), '', CONCAT('sku-', n), n FROM ${Numbers(3)} AS numbers WHERE n < ${param(ROWS)}`,
  );
}

/** The warnings logged while `work` runs. */
async function CaptureWarnings(work: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const original = Logger.Warn.bind(Logger);
  Logger.Warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await work();
  } finally {
    Logger.Warn = original;
  }
  return warnings;
}

async function IndexNames(schemaId: string): Promise<string[]> {
  const rows = await Read(
    sql`SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${param(PhysicalTable(schemaId))} AND INDEX_NAME <> 'PRIMARY' ORDER BY INDEX_NAME`,
  );
  return rows.map((row) => String(row.get("name")));
}

/**
 * The server id of the connection running the statement that builds the table's unique index, once
 * one other than `stopped` runs it.
 */
async function BuildingConnection(
  schemaId: string,
  stopped: readonly number[],
): Promise<number> {
  const pattern = `ALTER TABLE \`${PhysicalTable(schemaId)}\` ADD UNIQUE INDEX%`;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const rows = await Read(
      sql`SELECT ID AS id FROM information_schema.PROCESSLIST WHERE INFO LIKE ${param(pattern)}`,
    );
    const running = rows
      .map((row) => Number(row.get("id")))
      .find((id) => !stopped.includes(id));
    if (running !== undefined) {
      return running;
    }
    await delay(POLL_MS);
  }
  return expect.fail("the unique index build never started");
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

/** Starts the insert at once, settled to `"stored"` or to the error it threw. */
function Inserting(
  schema: Schema<{ items: Item }>,
  item: Item,
): Promise<"stored" | Error> {
  return schema
    .instance()
    .table("items")
    .insert(item)
    .run()
    .then(
      () => "stored" as const,
      (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
    );
}

/**
 * Registers the unique index over a held table and writes a duplicate price. Each time the build
 * waits for the table, up to `times` times, runs `stop` on its connection from another session; then
 * lets the table go.
 */
async function DuplicateDuringStoppedBuild(
  schemaId: string,
  stop: (connection: number) => Sql,
  times: number,
): Promise<"stored" | Error> {
  await Fresh(schemaId);
  const held = await HoldTable(schemaId);
  const schema = new Schema<{ items: Item }>(schemaId, UNIQUE_PRICE);
  const duplicate = Inserting(schema, { _id: "duplicate", price: 7 });
  const stopped: number[] = [];
  while (stopped.length < times) {
    const building = await BuildingConnection(schemaId, stopped);
    await Run(stop(building));
    stopped.push(building);
  }
  await Release(held);
  return duplicate;
}

const STOPS = [
  {
    schemaId: "index_build_killed",
    what: "kills the build's connection",
    stop: (id: number) => sql`KILL ${int(id)}`,
    times: 1,
  },
  {
    schemaId: "index_build_killed_twice",
    what: "kills the connection of the build and of its next attempt",
    stop: (id: number) => sql`KILL ${int(id)}`,
    times: 2,
  },
  {
    schemaId: "index_build_interrupted",
    what: "kills the build's statement",
    stop: (id: number) => sql`KILL QUERY ${int(id)}`,
    times: 1,
  },
];

describe("a unique-index build the server stops", function () {
  this.timeout(90_000);

  afterEach(() => {
    for (const { schemaId } of STOPS) {
      Schemas.unregister(schemaId);
    }
  });

  for (const { schemaId, what, stop, times } of STOPS) {
    it(`builds the index on the pool when the server ${what}, and refuses the duplicate written meanwhile`, async () => {
      const outcome = await DuplicateDuringStoppedBuild(schemaId, stop, times);
      expect(IsDuplicateKeyError(outcome), String(outcome)).to.equal(true);
      await WaitForIndexes(schemaId);
      expect(await IndexNames(schemaId)).to.deep.equal(["price"]);
    });
  }
});

describe("a unique index the server refuses to build", function () {
  this.timeout(60_000);
  const schemaId = "index_build_refused";

  after(() => {
    Schemas.unregister(schemaId);
  });

  it("is not tried again when the rows already hold a duplicate: the phase ends at once, names the index, and lets writes through", async () => {
    await Fresh(schemaId);
    await Run(
      sql`UPDATE ${ident(PhysicalTable(schemaId))} SET price = 1 WHERE price = 2`,
    );
    let ended = false;
    const warnings = await CaptureWarnings(async () => {
      const schema = new Schema<{ items: Item }>(schemaId, UNIQUE_PRICE);
      await schema.instance().table("items").get("0000000").run();
      ended = await SettlesWithin(WaitForIndexes(schemaId), PROMPT_MS);
      await WaitForIndexes(schemaId);
      expect(
        await Inserting(schema, { _id: "written", price: 1 }),
        "the write is not held",
      ).to.equal("stored");
    });
    expect(
      ended,
      "the phase ends without trying the refused index again",
    ).to.equal(true);
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.match(
      /^Index phase of 'index_build_refused.items' could not addIndex 'price': Duplicate entry/,
    );
    expect(await IndexNames(schemaId)).to.deep.equal([]);
  });
});

describe("a registration made while a stopped unique-index build waits to start again", function () {
  this.timeout(60_000);
  const schemaId = "index_build_superseded";

  after(() => {
    Schemas.unregister(schemaId);
  });

  it("runs its index phase after that build's next attempt, so the index it no longer declares is not left behind", async () => {
    await Fresh(schemaId);
    const held = await HoldTable(schemaId);
    const schema = new Schema<{ items: Item }>(schemaId, UNIQUE_PRICE);
    await Run(sql`KILL ${int(await BuildingConnection(schemaId, []))}`);
    await Release(held);
    const stopped = WaitForIndexes(schemaId);
    await Schemas.register(schemaId, BARE);
    await WaitForIndexes(schemaId);
    await stopped;
    expect(await IndexNames(schemaId)).to.deep.equal([]);
    expect(await Inserting(schema, { _id: "duplicate", price: 7 })).to.equal(
      "stored",
    );
  });
});

/** Lets the account of `admin` open `perHour` new connections an hour, or any number for 0. */
async function ConnectionsPerHour(
  admin: PoolConnection,
  perHour: number,
): Promise<void> {
  const [row] = await Read(sql`SELECT CURRENT_USER() AS account`, admin);
  const account = String(row?.get("account"));
  const at = account.lastIndexOf("@");
  await Run(
    sql`ALTER USER ${lit(account.slice(0, at))}@${lit(account.slice(at + 1))} WITH MAX_CONNECTIONS_PER_HOUR ${int(perHour)}`,
    admin,
  );
  await Run(sql`FLUSH USER_RESOURCES`, admin);
}

describe("a unique-index build whose next attempt the server turns away", function () {
  this.timeout(60_000);
  const schemaId = "index_build_turned_away";
  const REFUSING_MS = 3000;

  after(() => {
    Schemas.unregister(schemaId);
  });

  it("keeps trying while the server refuses the pool new connections, and refuses the duplicate written meanwhile", async () => {
    await Fresh(schemaId);
    const admin = await AcquireConnection();
    const held = await HoldTable(schemaId);
    const schema = new Schema<{ items: Item }>(schemaId, UNIQUE_PRICE);
    const duplicate = Inserting(schema, { _id: "duplicate", price: 7 });
    await BuildingConnection(schemaId, []);
    let ended = false;
    try {
      await ConnectionsPerHour(admin, 1);
      const allowance = await createConnection(GetOptions().url);
      const others = await Read(
        sql`SELECT ID AS id FROM information_schema.PROCESSLIST WHERE USER = SUBSTRING_INDEX(CURRENT_USER(), '@', 1) AND ID NOT IN (CONNECTION_ID(), ${param(held.threadId)}, ${param(allowance.threadId)}) AND COMMAND <> 'Daemon'`,
        admin,
      );
      for (const id of others.map((row) => Number(row.get("id")))) {
        await Run(sql`KILL ${int(id)}`, admin).catch(() => undefined);
      }
      void WaitForIndexes(schemaId).then(() => {
        ended = true;
      });
      await delay(REFUSING_MS);
      await allowance.end();
    } finally {
      await ConnectionsPerHour(admin, 0);
      admin.release();
    }
    expect(
      ended,
      "the phase still tries while connections are refused",
    ).to.equal(false);
    await Release(held);
    const outcome = await duplicate;
    expect(IsDuplicateKeyError(outcome), String(outcome)).to.equal(true);
    await WaitForIndexes(schemaId);
    expect(await IndexNames(schemaId)).to.deep.equal(["price"]);
  });
});
