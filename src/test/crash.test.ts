import { expect } from "chai";
import type { TableDefinition } from "@antelopejs/interface-database/schema";

import type { MigrationMode } from "../config";
import { type Sql, ident, param, sql } from "../statement";
import {
  AcquireConnection,
  GetDialect,
  GetSchemaPrefix,
  type Row,
} from "../connection";
import { ParseTable } from "../implementations/database/fields";
import {
  BuildTablePlan,
  type TablePlan,
} from "../implementations/database/plan";
import {
  type ConvergenceSession,
  SessionOf,
} from "../implementations/database/locks";
import { ConvergeTable } from "../implementations/database/migrate-tables";
import { ConvergeIndexes } from "../implementations/database/migrate-indexes";

/** What a session that dies mid-convergence throws in place of its next statement. */
class Crash extends Error {}

interface CrashCase {
  readonly name: string;
  readonly start?: TableDefinition;
  readonly seed?: (table: Sql) => Sql;
  readonly target: TableDefinition;
  readonly mode: MigrationMode;
}

interface Budgeted {
  readonly session: ConvergenceSession;
  spent(): number;
}

const NEVER = () => false;
const SAFE: MigrationMode = "safe";
const DESTRUCTIVE: MigrationMode = "destructive";

/** Ten thousand rows of `n`, from 0, for seeding with one statement. */
const NUMBERS = sql`(SELECT a.d + 10 * b.d + 100 * c.d + 1000 * e.d AS n FROM (SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) AS a CROSS JOIN (SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) AS b CROSS JOIN (SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) AS c CROSS JOIN (SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) AS e)`;

const ITEMS: TableDefinition = {
  fields: { sku: "string", price: "number", title: "object" },
  indexes: {
    sku: { unique: true, crossInstance: true },
    price: {},
    titleFr: { fields: ["title.fr"] },
  },
};

/**
 * 2500 rows over two instances, so a backfill takes three chunks and crosses an instance. Field `b`
 * sits in `_extra` as a string on most rows, as a number on some, which a string column cannot
 * take, and as JSON null on others, which stays in `_extra` as an explicit null.
 */
function SeedExtra(table: Sql): Sql {
  return sql`INSERT INTO ${table} (_id, _instance, a, _extra) SELECT LPAD(n, 5, '0'), IF(n < 1200, '', 'tenant'), CONCAT('a', n), CASE n % 10 WHEN 0 THEN JSON_OBJECT('b', n) WHEN 1 THEN JSON_OBJECT('b', CAST('null' AS JSON)) ELSE JSON_OBJECT('b', CONCAT('b', n), 'keep', n) END FROM ${NUMBERS} AS numbers WHERE n < 2500`;
}

function SeedPrices(table: Sql): Sql {
  return sql`INSERT INTO ${table} (_id, _instance, sku, price) SELECT LPAD(n, 4, '0'), '', CONCAT('sku-', n), IF(n % 7 = 0, NULL, CONCAT(n, '.5')) FROM ${NUMBERS} AS numbers WHERE n < 50`;
}

function SeedRanks(table: Sql): Sql {
  return sql`INSERT INTO ${table} (_id, _instance, sku, price, rnk) SELECT LPAD(n, 4, '0'), '', CONCAT('sku-', n), n, n % 3 FROM ${NUMBERS} AS numbers WHERE n < 50`;
}

function SeedTitles(table: Sql): Sql {
  return sql`INSERT INTO ${table} (_id, _instance, title) SELECT LPAD(n, 4, '0'), '', IF(n % 5 = 0, JSON_OBJECT('fr', n), JSON_OBJECT('fr', CONCAT('titre ', n), 'en', CONCAT('title ', n))) FROM ${NUMBERS} AS numbers WHERE n < 50`;
}

const CASES: readonly CrashCase[] = [
  { name: "create", target: ITEMS, mode: SAFE },
  {
    name: "add column with backfill",
    start: { fields: { a: "string" }, indexes: {} },
    seed: SeedExtra,
    target: { fields: { a: "string", b: "string" }, indexes: {} },
    mode: SAFE,
  },
  {
    name: "retype",
    start: {
      fields: { sku: "string", price: "string" },
      indexes: { price: {} },
    },
    seed: SeedPrices,
    target: {
      fields: { sku: "string", price: "number" },
      indexes: { price: {} },
    },
    mode: DESTRUCTIVE,
  },
  {
    name: "undeclared drop",
    start: {
      fields: { sku: "string", price: "string" },
      indexes: { price: { unique: true } },
    },
    seed: SeedPrices,
    target: { fields: { sku: "string" }, indexes: {} },
    mode: DESTRUCTIVE,
  },
  {
    name: "index add",
    start: {
      fields: { sku: "string", price: "number", rnk: "number" },
      indexes: {},
    },
    seed: SeedRanks,
    target: {
      fields: { sku: "string", price: "number", rnk: "number" },
      indexes: { price: { unique: true }, rnk: {} },
    },
    mode: SAFE,
  },
  {
    name: "index swap",
    start: {
      fields: { sku: "string", price: "number", rnk: "number" },
      indexes: { price: {} },
    },
    seed: SeedRanks,
    target: {
      fields: { sku: "string", price: "number", rnk: "number" },
      indexes: { price: { fields: ["price", "rnk"] } },
    },
    mode: SAFE,
  },
  {
    name: "index drop",
    start: {
      fields: { sku: "string", price: "number", rnk: "number" },
      indexes: { sku: { crossInstance: true }, price: {} },
    },
    seed: SeedRanks,
    target: {
      fields: { sku: "string", price: "number", rnk: "number" },
      indexes: {},
    },
    mode: SAFE,
  },
  {
    name: "key-column add",
    start: { fields: { title: "object" }, indexes: {} },
    seed: SeedTitles,
    target: {
      fields: { title: "object" },
      indexes: {
        titleFr: { fields: ["title.fr"] },
        wholeTitle: { fields: ["title"] },
      },
    },
    mode: SAFE,
  },
];

/** Whether convergence stopped because its session crashed, whatever step it reported it on. */
function IsCrash(cause: unknown): boolean {
  return (
    cause instanceof Crash || (cause instanceof Error && IsCrash(cause.cause))
  );
}

function Plan(schemaId: string, definition: TableDefinition): TablePlan {
  return BuildTablePlan(
    schemaId,
    "items",
    definition,
    ParseTable(definition, `${schemaId}.items`),
    { prefix: GetSchemaPrefix(), session: GetDialect().session },
  ).plan;
}

/** A session whose statements that change something stop running after `budget` of them. */
function Budget(session: ConvergenceSession, budget: number): Budgeted {
  let spent = 0;
  const spend = (run: () => Promise<number>): Promise<number> => {
    if (spent >= budget) {
      return Promise.reject(new Crash(`crashed after ${spent} statements`));
    }
    spent += 1;
    return run();
  };
  return {
    session: {
      id: session.id,
      read: (statement) => session.read(statement),
      apply: (statement) => spend(() => session.apply(statement)),
      write: (statement) => spend(() => session.write(statement)),
    },
    spent: () => spent,
  };
}

/** The tables phase, then the index phase, as one registration runs them. */
async function Converge(
  session: ConvergenceSession,
  plan: TablePlan,
  mode: MigrationMode,
): Promise<void> {
  await ConvergeTable(session, plan, mode);
  await ConvergeIndexes(session, plan, NEVER);
}

function Cells(rows: readonly Row[]): string[][] {
  return rows.map((row) =>
    [...row.values()].map((cell) =>
      Buffer.isBuffer(cell) ? cell.toString("utf8") : String(cell),
    ),
  );
}

/** The table's catalog entry, columns, indexes and every row, in a stable order. */
async function Snapshot(session: ConvergenceSession, table: string) {
  const name = param(table);
  const where = sql`TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${name}`;
  return {
    table: Cells(
      await session.read(
        sql`SELECT TABLE_COMMENT FROM information_schema.TABLES WHERE ${where}`,
      ),
    ),
    columns: Cells(
      await session.read(
        sql`SELECT COLUMN_NAME, COLUMN_TYPE, EXTRA, COLUMN_COMMENT, GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE ${where} ORDER BY ORDINAL_POSITION`,
      ),
    ),
    indexes: Cells(
      await session.read(
        sql`SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, EXPRESSION, INDEX_COMMENT FROM information_schema.STATISTICS WHERE ${where} ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      ),
    ),
    rows: Cells(
      await session.read(
        sql`SELECT * FROM ${ident(table)} ORDER BY _instance, _id`,
      ),
    ),
  };
}

/** Drops the table, then builds the case's starting catalog and rows. */
async function Start(
  session: ConvergenceSession,
  schemaId: string,
  crash: CrashCase,
): Promise<TablePlan> {
  const target = Plan(schemaId, crash.target);
  await session.apply(sql`DROP TABLE IF EXISTS ${ident(target.table)}`);
  if (crash.start) {
    await Converge(session, Plan(schemaId, crash.start), SAFE);
  }
  if (crash.seed) {
    await session.write(crash.seed(ident(target.table)));
  }
  return target;
}

describe("convergence stopped after any statement", function () {
  this.timeout(120_000);

  let session: ConvergenceSession;
  let release: () => void;

  before(async () => {
    const connection = await AcquireConnection();
    session = SessionOf(connection);
    release = () => connection.release();
  });

  after(() => {
    release();
  });

  for (const crash of CASES) {
    it(`finishes '${crash.name}' with the catalog and rows of an uninterrupted run`, async () => {
      const schemaId = `crash_${crash.name.replaceAll(/[^a-z]/g, "_")}`;
      const plan = await Start(session, schemaId, crash);
      const counted = Budget(session, Number.POSITIVE_INFINITY);
      await Converge(counted.session, plan, crash.mode);
      const statements = counted.spent();
      expect(statements, "statements an uninterrupted run takes").to.be.above(
        0,
      );
      const reference = await Snapshot(session, plan.table);
      await Converge(counted.session, plan, crash.mode);
      expect(counted.spent(), "a converged table takes no statement").to.equal(
        statements,
      );

      for (let budget = 0; budget < statements; budget++) {
        await Start(session, schemaId, crash);
        const crashing = Budget(session, budget);
        const stopped = await Converge(crashing.session, plan, crash.mode).then(
          () => false,
          IsCrash,
        );
        expect(stopped, `a crash after ${budget} statements`).to.equal(true);
        await Converge(session, plan, crash.mode);
        expect(
          await Snapshot(session, plan.table),
          `converged again after a crash after ${budget} of ${statements} statements`,
        ).to.deep.equal(reference);
      }
    });
  }
});
