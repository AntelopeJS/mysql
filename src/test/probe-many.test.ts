import { expect } from "chai";
import { createConnection } from "mysql2/promise";
import { randomBytes } from "node:crypto";

import { GetOptions } from "../config";
import { probe } from "../probe";
import { CommandCounter, PREPARE_COMMAND, Relay } from "./unit/probe-fixture";

const DATABASE = "probe_many";
const RELATIONS = 1000;
const READER = "probe_many_reader";
const SECRET = randomBytes(6).toString("hex");
/** A timeout the probe meets on each answer; the DMS check gives up after three of them. */
const TIMEOUT_MS = 400;
const DEADLINE_IN_TIMEOUTS = 3;
/** What the probe prepares besides one statement per relation: the listing, one confirmed read and the `CREATE TABLE` check. */
const FIXED_PREPARES = 3;

const TEARDOWN = [
  `DROP DATABASE IF EXISTS ${DATABASE}`,
  `DROP USER IF EXISTS '${READER}'@'%'`,
];

const SETUP = [
  ...TEARDOWN,
  `CREATE DATABASE ${DATABASE}`,
  ...Array.from(
    { length: RELATIONS },
    (_, index) => `CREATE TABLE ${DATABASE}.t${index} (id INT PRIMARY KEY)`,
  ),
  `CREATE USER '${READER}'@'%' IDENTIFIED BY '${SECRET}'`,
  `GRANT SELECT ON ${DATABASE}.* TO '${READER}'@'%'`,
];

describe("probe, against a database of many relations", function () {
  this.timeout(180_000);
  const admin = new URL(GetOptions().url ?? "");

  async function AsAdmin(statements: readonly string[]): Promise<void> {
    const connection = await createConnection({
      uri: admin.toString(),
      multipleStatements: true,
    });
    try {
      await connection.query(statements.join(";\n"));
    } finally {
      await connection.end();
    }
  }

  before(() => AsAdmin(SETUP));
  after(() => AsAdmin(TEARDOWN));

  /**
   * Fails on a probe that confirms every relation readable before it answers. A read-only account
   * is the one whose every relation the write check asks the server about.
   */
  it("asks about each relation once for a read-only account, within the deadline of the DMS check", async () => {
    const prepares = CommandCounter(PREPARE_COMMAND);
    const relay = await Relay(admin.hostname, Number(admin.port || 3306), {
      answer: prepares.answer,
    });
    try {
      const started = performance.now();
      const answer = await probe({
        url: `mysql://${READER}:${SECRET}@127.0.0.1:${relay.port}/${DATABASE}`,
        timeoutMs: TIMEOUT_MS,
        signal: new AbortController().signal,
      });
      expect(answer).to.include({
        outcome: "signed-in",
        canRead: true,
        canWrite: false,
      });
      expect(prepares.count()).to.be.at.most(RELATIONS + FIXED_PREPARES);
      expect(performance.now() - started).to.be.lessThan(
        TIMEOUT_MS * DEADLINE_IN_TIMEOUTS,
      );
    } finally {
      await relay.close();
    }
  });
});
