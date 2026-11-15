import { expect } from "chai";
import { type RowDataPacket, createConnection } from "mysql2/promise";
import { randomBytes } from "node:crypto";

import { GetOptions } from "../config";
import { probe } from "../probe";
import { TIMEOUT_MS, Unaborted } from "./unit/probe-fixture";

const DATABASE = "probe_locked";
const READER = "probe_locked_reader";
const SECRET = randomBytes(6).toString("hex");
const POLL_MS = 50;
/** How long the server may take to end the probe's wait once the probe has gone: its lock wait bound and a margin. */
const SETTLE_MS = 5000;

const TEARDOWN = [
  `DROP DATABASE IF EXISTS ${DATABASE}`,
  `DROP USER IF EXISTS '${READER}'@'%'`,
];

const SETUP = [
  ...TEARDOWN,
  `CREATE DATABASE ${DATABASE}`,
  `CREATE TABLE ${DATABASE}.t (id INT PRIMARY KEY)`,
  `CREATE USER '${READER}'@'%' IDENTIFIED BY '${SECRET}'`,
  `GRANT SELECT ON ${DATABASE}.* TO '${READER}'@'%'`,
];

async function Until(
  condition: () => Promise<boolean>,
  withinMs: number,
): Promise<boolean> {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    if (await condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return condition();
}

describe("probe, on a relation another session holds a lock on", function () {
  this.timeout(60_000);
  const admin = new URL(GetOptions().url ?? "");

  async function AsAdmin(statements: readonly string[]): Promise<void> {
    const connection = await createConnection(admin.toString());
    try {
      for (const statement of statements) {
        await connection.query(statement);
      }
    } finally {
      await connection.end();
    }
  }

  before(() => AsAdmin(SETUP));
  after(() => AsAdmin(TEARDOWN));

  /**
   * Fails on a probe that leaves the server waiting on a metadata lock after it has answered:
   * MySQL notices a closed client only once the wait ends, which `lock_wait_timeout` puts a year
   * away by default.
   */
  it("answers within the timeout and leaves no session of its own waiting on the server", async () => {
    const holder = await createConnection(admin.toString());
    const alterer = await createConnection(admin.toString());
    const watcher = await createConnection(admin.toString());
    const sessions = async (where: string, value: string) => {
      const [rows] = await watcher.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE ${where}`,
        [value],
      );
      return Number(rows[0]?.n);
    };
    try {
      await holder.query("START TRANSACTION");
      await holder.query(`SELECT * FROM ${DATABASE}.t`);
      const altering = alterer
        .query(`ALTER TABLE ${DATABASE}.t ADD COLUMN c INT`)
        .catch(() => undefined);
      expect(
        await Until(
          async () => (await sessions("STATE LIKE ?", "%metadata lock%")) > 0,
          SETTLE_MS,
        ),
      ).to.equal(true);
      const started = performance.now();
      const answer = await probe({
        url: `mysql://${READER}:${SECRET}@${admin.hostname}:${admin.port || 3306}/${DATABASE}`,
        timeoutMs: TIMEOUT_MS,
        signal: Unaborted(),
      });
      expect(performance.now() - started).to.be.lessThan(TIMEOUT_MS * 2);
      expect(answer.outcome).to.equal("unreachable");
      expect(
        await Until(
          async () => (await sessions("USER = ?", READER)) === 0,
          SETTLE_MS,
        ),
      ).to.equal(true);
      await holder.query("ROLLBACK");
      await altering;
    } finally {
      await Promise.all([holder.end(), alterer.end(), watcher.end()]);
    }
  });
});
