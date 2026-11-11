import { expect } from "chai";
import path from "node:path";
import { spawn } from "node:child_process";

import { Logger } from "../logger";
import { GetOptions } from "../config";
import { AcquireConnection, GetSchemaPrefix } from "../connection";
import { type Sql, ident, sql } from "../statement";
import { TableName } from "../implementations/database/identifier";
import { SessionOf } from "../implementations/database/locks";
import { Schemas, WaitForIndexes } from "../implementations/database/schema";
import {
  BEFORE,
  CONTENDED,
  SCHEMA_VARIABLE,
  URL_VARIABLE,
} from "./contention-schema";
import { Snapshot } from "./snapshot";

interface Exit {
  readonly code: number | null;
  readonly stderr: string;
  readonly logged: readonly string[];
}

const OTHER_PROCESSES = 2;
const IN_THIS_PROCESS = 2;
const REGISTERING_PROCESS = path.join(__dirname, "register-process.js");
const DIGITS = sql`(SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)`;

function Table(schemaId: string): string {
  return TableName(GetSchemaPrefix(), schemaId, "items");
}

async function Run(statement: Sql): Promise<void> {
  const connection = await AcquireConnection();
  try {
    await SessionOf(connection).apply(statement);
  } finally {
    connection.release();
  }
}

/** The table as {@link BEFORE} declares it, with 3000 rows over two instances holding `b` in `_extra`. */
async function Prepare(schemaId: string): Promise<void> {
  const table = ident(Table(schemaId));
  await Run(sql`DROP TABLE IF EXISTS ${table}`);
  await Schemas.register(schemaId, BEFORE);
  await WaitForIndexes(schemaId);
  await Run(
    sql`INSERT INTO ${table} (_id, _instance, a, _extra) SELECT LPAD(n, 4, '0'), IF(n % 2 = 0, '', 'tenant'), CONCAT('a-', n), JSON_OBJECT('b', CONCAT('b-', n % 100), 'note', JSON_OBJECT('text', CONCAT('note ', n))) FROM (SELECT a.d + 10 * b.d + 100 * c.d + 1000 * e.d AS n FROM ${DIGITS} AS a CROSS JOIN ${DIGITS} AS b CROSS JOIN ${DIGITS} AS c CROSS JOIN ${DIGITS} AS e) AS numbers WHERE n < 3000`,
  );
}

/** Registers {@link CONTENDED} from another process with a module instance of its own. */
function RegisterElsewhere(schemaId: string): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [REGISTERING_PROCESS], {
      env: {
        ...process.env,
        [URL_VARIABLE]: GetOptions().url,
        [SCHEMA_VARIABLE]: schemaId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr, logged: stdout.split("\n").filter(Boolean) });
    });
  });
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
    const alone = await Snapshot(Table("contention_alone"));
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
    expect(await Snapshot(Table(schemaId))).to.deep.equal(alone);
    const converged = [...here, ...exits.flatMap((exit) => exit.logged)].filter(
      (line) => line.startsWith(`converged the tables of schema '${schemaId}'`),
    );
    expect(
      converged,
      "one contender converged; the others found nothing to do",
    ).to.have.length(1);
  });
});
