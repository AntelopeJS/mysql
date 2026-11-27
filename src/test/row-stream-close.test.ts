import { expect } from "chai";
import { setTimeout as delay } from "node:timers/promises";

import { type Sql, sql } from "../statement";
import { Read } from "../connection";
import { Logger } from "../logger";
import { OpenRowStream } from "../implementations/database/row-stream";

/** Long enough for the driver to answer whatever the closed statement left in flight. */
const SETTLE_MS = 300;

const STATEMENTS: ReadonlyArray<readonly [string, Sql]> = [
  ["reads only columns", sql`SELECT 1 AS one`],
  ["calls a JSON function", sql`SELECT JSON_ARRAY(1) AS j`],
];

/** What `Logger.Warn` was given while `work` ran and settled. */
async function Warned(work: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const original = Logger.Warn.bind(Logger);
  Logger.Warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await work();
    await delay(SETTLE_MS);
  } finally {
    Logger.Warn = original;
  }
  return warnings;
}

describe("a cursor's stream closed before its first read", function () {
  this.timeout(30_000);

  for (const [name, statement] of STATEMENTS) {
    it(`logs no failed connection where the statement ${name}`, async () => {
      const warnings = await Warned(async () => {
        const source = await OpenRowStream(statement, 10);
        await source.close();
      });
      const [after] = await Read(sql`SELECT 1 AS one`);
      expect({ warnings, after: Number(after?.get("one")) }).to.deep.equal({
        warnings: [],
        after: 1,
      });
    });
  }
});
