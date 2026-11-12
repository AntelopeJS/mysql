import { expect } from "chai";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Connection,
  type RowDataPacket,
  createConnection,
} from "mysql2/promise";

import { Logger } from "../logger";
import {
  AcquireConnection,
  GetDialect,
  GetSchemaPrefix,
  Read,
} from "../connection";
import { Bind, ident, lit, sql } from "../statement";
import { GetOptions, type ResolvedOptions } from "../config";
import { SchemaKey } from "../implementations/database/registry";
import { ParseTable } from "../implementations/database/fields";
import { BuildTablePlan } from "../implementations/database/plan";
import { PENDING } from "../implementations/database/convergence";
import { ConvergeTable } from "../implementations/database/migrate-tables";
import { ConvergeIndexes } from "../implementations/database/migrate-indexes";
import {
  type ConvergenceSession,
  SessionOf,
} from "../implementations/database/locks";
import { Schemas, WaitForIndexes } from "../implementations/database/schema";
import { BEFORE, CONTENDED } from "./contention-schema";
import { type Exit, RegisterElsewhere } from "./elsewhere";
import { Numbers, PhysicalTable, Reconnect, Run, Snapshot } from "./tables";
import { SettlesWithin } from "./watch";

const OTHER_PROCESSES = 2;
/** Longer than the five seconds a DDL statement waits for a metadata lock. */
const HELD_MS = 6000;
const IN_THIS_PROCESS = 2;

/** The table as {@link BEFORE} declares it, with 3000 rows over two instances holding `b` in `_extra`. */
async function Prepare(schemaId: string): Promise<void> {
  const table = ident(PhysicalTable(schemaId));
  await Run(sql`DROP TABLE IF EXISTS ${table}`);
  await Schemas.register(schemaId, BEFORE);
  await WaitForIndexes(schemaId);
  await Run(
    sql`INSERT INTO ${table} (_id, _instance, a, _extra) SELECT LPAD(n, 4, '0'), IF(n % 2 = 0, '', 'tenant'), CONCAT('a-', n), JSON_OBJECT('b', CONCAT('b-', n % 100), 'note', JSON_OBJECT('text', CONCAT('note ', n))) FROM ${Numbers(4)} AS numbers WHERE n < 3000`,
  );
}

async function RegisterHere(schemaId: string): Promise<void> {
  await Schemas.register(schemaId, CONTENDED);
  await WaitForIndexes(schemaId);
}

/** Runs `work` with the module's information lines recorded, and answers them. */
async function CaptureInfo(work: () => Promise<void>): Promise<string[]> {
  const logged: string[] = [];
  const original = Logger.Info.bind(Logger);
  Logger.Info = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    await work();
  } finally {
    Logger.Info = original;
  }
  return logged;
}

describe("one schema registered by several module instances at once", function () {
  this.timeout(120_000);

  after(() => {
    Schemas.unregister("contention_alone");
    Schemas.unregister("contention_together");
  });

  it("converges to what one registration alone builds, every registration succeeding", async () => {
    await Prepare("contention_alone");
    await RegisterHere("contention_alone");
    const alone = await Snapshot(PhysicalTable("contention_alone"));
    expect(alone.indexes, "the reference built its indexes").to.not.deep.equal(
      [],
    );

    const schemaId = "contention_together";
    await Prepare(schemaId);
    let exits: Exit[] = [];
    const here = await CaptureInfo(async () => {
      const elsewhere = Array.from({ length: OTHER_PROCESSES }, () =>
        RegisterElsewhere(schemaId),
      );
      await Promise.all(
        Array.from({ length: IN_THIS_PROCESS }, () => RegisterHere(schemaId)),
      );
      exits = await Promise.all(elsewhere);
    });
    expect(exits.map(({ code, stderr }) => ({ code, stderr }))).to.deep.equal(
      Array.from({ length: OTHER_PROCESSES }, () => ({ code: 0, stderr: "" })),
    );
    expect(await Snapshot(PhysicalTable(schemaId))).to.deep.equal(alone);
    const converged = [...here, ...exits.flatMap((exit) => exit.logged)].filter(
      (line) => line.startsWith(`converged the tables of schema '${schemaId}'`),
    );
    expect(
      converged,
      "one contender converged; the others found nothing to do",
    ).to.have.length(1);
  });
});

describe("a convergence step that meets another session", function () {
  this.timeout(60_000);

  after(() => {
    Schemas.unregister("contention_reference");
    Schemas.unregister("contention_waited");
  });

  it("is tried again once a transaction holding its table ends", async () => {
    const schemaId = "contention_waited";
    await Prepare(schemaId);
    const holder = await AcquireConnection();
    await SessionOf(holder).apply(sql`START TRANSACTION`);
    await Read(
      sql`SELECT _id FROM ${ident(PhysicalTable(schemaId))} LIMIT 1`,
      holder,
    );
    const started = Date.now();
    const released = delay(HELD_MS).then(async () => {
      await SessionOf(holder).apply(sql`COMMIT`);
      holder.release();
    });
    await RegisterHere(schemaId);
    await released;
    expect(Date.now() - started, "it outwaited one lock timeout").to.be.above(
      HELD_MS,
    );
    await Prepare("contention_reference");
    await RegisterHere("contention_reference");
    expect(await Snapshot(PhysicalTable(schemaId))).to.deep.equal(
      await Snapshot(PhysicalTable("contention_reference")),
    );
  });

  it("counts a step another session applied first as done, and goes on from there", async () => {
    const schemaId = "contention_raced";
    await Prepare(schemaId);
    Schemas.unregister(schemaId);
    const table = ident(PhysicalTable(schemaId));
    const plan = BuildTablePlan(
      schemaId,
      "items",
      CONTENDED.items,
      ParseTable(CONTENDED.items, `${schemaId}.items`),
      { prefix: GetSchemaPrefix(), session: GetDialect().session },
    ).plan;
    const connection = await AcquireConnection();
    const session = SessionOf(connection);
    let isRaced = false;
    const raced: ConvergenceSession = {
      ...session,
      apply: async (statement) => {
        if (!isRaced) {
          isRaced = true;
          await Run(
            sql`ALTER TABLE ${table} ADD COLUMN b LONGTEXT NULL COMMENT ${lit(PENDING)}`,
          );
        }
        return session.apply(statement);
      },
    };
    try {
      await ConvergeTable(raced, plan, "safe");
      await ConvergeIndexes(raced, plan, () => false);
    } finally {
      connection.release();
    }
    expect(isRaced).to.equal(true);
    await Prepare("contention_reference");
    await RegisterHere("contention_reference");
    expect(await Snapshot(PhysicalTable(schemaId))).to.deep.equal(
      await Snapshot(PhysicalTable("contention_reference")),
    );
  });
});

/** A connection of another process, outside this one's pool, holding the tables lock of each schema. */
async function HoldTablesPhasesElsewhere(
  url: string,
  schemaIds: readonly string[],
): Promise<Connection> {
  const dialect = GetDialect();
  const [database] = await Read(dialect.catalog.readDatabase());
  const elsewhere = await createConnection(url);
  for (const schemaId of schemaIds) {
    const name = dialect.session.lockName(
      "tables",
      `${String(database?.get("name"))}/${SchemaKey(schemaId)}`,
    );
    const take = Bind(dialect.session.acquireLock(name, 0));
    const [rows] = await elsewhere.query<RowDataPacket[]>(take.sql, [
      ...take.args,
    ]);
    expect(Number(rows[0]?.acquired), "the lock is free to take").to.equal(1);
  }
  return elsewhere;
}

describe("tables phases waiting for another process's convergence", function () {
  this.timeout(60_000);
  const reader = "tables_phase_reader";
  const waiting = ["tables_phase_waiting_a", "tables_phase_waiting_b"];
  const waited = 300;
  let restore: ResolvedOptions;

  before(async () => {
    await Prepare(reader);
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

  it("hold no pooled connection while they wait, so a read of a ready schema runs", async () => {
    const elsewhere = await HoldTablesPhasesElsewhere(restore.url, waiting);
    const registrations = waiting.map((schemaId) =>
      Schemas.register(schemaId, BEFORE),
    );
    await delay(waited);
    const read = Read(
      sql`SELECT a FROM ${ident(PhysicalTable(reader))} WHERE _instance = '' AND _id = '0000'`,
    );
    const isPrompt = await SettlesWithin(read, waited * 10);
    await elsewhere.end();
    expect(
      isPrompt,
      "the read is not queued behind the waiting tables phases",
    ).to.equal(true);
    expect((await read)[0]?.get("a")).to.equal("a-0");
    await Promise.all(registrations);
    for (const schemaId of waiting) {
      await WaitForIndexes(schemaId);
    }
  });
});
