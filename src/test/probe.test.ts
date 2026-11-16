import { expect } from "chai";
import { type RowDataPacket, createConnection } from "mysql2/promise";
import { randomBytes } from "node:crypto";

import { GetOptions } from "../config";
import { type DialectId, DetectDialect } from "../dialect";
import { probe } from "../probe";
import { TIMEOUT_MS, Unaborted } from "./unit/probe-fixture";

const DATABASE = "probe_shop";
const EMPTY = "probe_empty";
const SECRET = randomBytes(6).toString("hex");
const WRONG_SECRET = randomBytes(6).toString("hex");

/** An account named with `@` that reads the database only through a role another role holds. */
const ROLE_USER = "ops@team";
const ROLES = ["probe_shop_read", "probe_shop_staff"];

const GRANTS: readonly (readonly [string, string])[] = [
  ["probe_reader", `SELECT ON ${DATABASE}.*`],
  ["probe_writer", `SELECT, INSERT, UPDATE, DELETE ON ${DATABASE}.*`],
  ["probe_inserter", `INSERT ON ${DATABASE}.orders`],
  ["probe_updater", `UPDATE ON ${DATABASE}.notes`],
  ["probe_deleter", `DELETE ON ${DATABASE}.notes`],
  ["probe_blind", `SELECT (id) ON ${DATABASE}.orders`],
  ["probe_builder", `SELECT, CREATE ON ${EMPTY}.*`],
];
const STRANGER = "probe_stranger";
const USERS = [...GRANTS.map(([user]) => user), STRANGER, ROLE_USER];

const DEFAULT_ROLE = {
  mysql: `SET DEFAULT ROLE ALL TO '${ROLE_USER}'@'%'`,
  mariadb: `SET DEFAULT ROLE ${ROLES[1]} FOR '${ROLE_USER}'@'%'`,
};

function Account(user: string): string {
  return `'${user}'@'%'`;
}

const TEARDOWN = [
  `DROP DATABASE IF EXISTS ${DATABASE}`,
  `DROP DATABASE IF EXISTS ${EMPTY}`,
  ...USERS.map((user) => `DROP USER IF EXISTS ${Account(user)}`),
  ...ROLES.map((role) => `DROP ROLE IF EXISTS ${role}`),
];

const SETUP = [
  ...TEARDOWN,
  `CREATE DATABASE ${DATABASE}`,
  `CREATE DATABASE ${EMPTY}`,
  `CREATE TABLE ${DATABASE}.orders (id int PRIMARY KEY, total int)`,
  `CREATE TABLE ${DATABASE}.notes (id int PRIMARY KEY)`,
  ...USERS.map(
    (user) => `CREATE USER ${Account(user)} IDENTIFIED BY '${SECRET}'`,
  ),
  ...GRANTS.map(([user, grant]) => `GRANT ${grant} TO ${Account(user)}`),
  `GRANT SELECT ON ${EMPTY}.* TO ${Account("probe_reader")}`,
  ...ROLES.map((role) => `CREATE ROLE ${role}`),
  `GRANT SELECT ON ${DATABASE}.* TO ${ROLES[0]}`,
  `GRANT ${ROLES[0]} TO ${ROLES[1]}`,
  `GRANT ${ROLES[1]} TO ${Account(ROLE_USER)}`,
];

describe("probe, against a live server", function () {
  this.timeout(30_000);
  const admin = new URL(GetOptions().url ?? "");
  const host = admin.hostname;
  const port = Number(admin.port || 3306);

  function Url(user: string, password = SECRET, database = DATABASE): string {
    return `mysql://${encodeURIComponent(user)}:${password}@${host}:${port}/${database}`;
  }

  function Probe(url: string) {
    return probe({ url, timeoutMs: TIMEOUT_MS, signal: Unaborted() });
  }

  async function AsAdmin(
    statements: (engine: DialectId) => readonly string[],
  ): Promise<void> {
    const connection = await createConnection(admin.toString());
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT VERSION() AS version",
      );
      for (const statement of statements(
        DetectDialect(String(rows[0]?.version)),
      )) {
        await connection.query(statement);
      }
    } finally {
      await connection.end();
    }
  }

  before(() => AsAdmin((engine) => [...SETUP, DEFAULT_ROLE[engine]]));
  after(() => AsAdmin(() => TEARDOWN));

  it("answers read access and no write access to an account that may only SELECT", async () => {
    const answer = await Probe(Url("probe_reader"));
    expect(answer).to.include({
      outcome: "signed-in",
      user: "probe_reader@%",
      canRead: true,
      canWrite: false,
    });
    expect(answer).to.not.have.property("unreadable");
    expect(answer).to.have.property("latencyMs").that.is.above(0);
  });

  /**
   * Fails on a probe that answers no read access to an account that sees no relation, or that
   * answers write access on a database with no relation by anything but the right to create tables.
   */
  it("answers read access to an account that sees no relation, and write access only if it may create tables", async () => {
    for (const [user, canWrite] of [
      ["probe_reader", false],
      ["probe_builder", true],
    ] as const) {
      const answer = await Probe(Url(user, SECRET, EMPTY));
      expect(answer, user).to.include({
        outcome: "signed-in",
        canRead: true,
        canWrite,
      });
      expect(answer, user).to.not.have.property("unreadable");
    }
  });

  it("answers read and write access to an account that may write", async () => {
    const answer = await Probe(Url("probe_writer"));
    expect(answer).to.include({ canRead: true, canWrite: true });
  });

  /** Fails on a probe that counts only INSERT and UPDATE as writes, as the column privileges tell them. */
  it("answers write access without read access to an account that may only DELETE", async () => {
    const answer = await Probe(Url("probe_deleter"));
    expect(answer).to.include({
      outcome: "signed-in",
      canRead: false,
      canWrite: true,
    });
  });

  /** Fails on a probe that counts INSERT or UPDATE on a relation the account cannot read. */
  it("answers no access to an account that may only INSERT or UPDATE", async () => {
    for (const user of ["probe_inserter", "probe_updater"]) {
      const answer = await Probe(Url(user));
      expect(answer, user).to.include({ canRead: false, canWrite: false });
    }
  });

  /** Fails on a probe that matches grantees by the account's name instead of the session's privileges. */
  it("answers read access to an account named with @ that reads through a role another role holds", async () => {
    const answer = await Probe(Url(ROLE_USER));
    expect(answer).to.include({
      outcome: "signed-in",
      user: `${ROLE_USER}@%`,
      canRead: true,
      canWrite: false,
    });
  });

  /** Fails on a probe that counts a relation readable when SELECT covers some of its columns only. */
  it("answers no access to an account granted some columns only", async () => {
    const answer = await Probe(Url("probe_blind"));
    expect(answer).to.include({ canRead: false, canWrite: false });
  });

  it("answers a wrong password as a refusal of the credentials, without the password", async () => {
    const answer = await Probe(Url("probe_reader", WRONG_SECRET));
    expect(answer).to.include({ outcome: "refused", refusal: "credentials" });
    expect(JSON.stringify(answer)).to.not.include(WRONG_SECRET);
  });

  /** Fails on a probe that answers a URL without the password the account needs as a wrong password. */
  it("answers a URL that gives no password for an account that has one as a sign-in it requires", async () => {
    expect(await Probe(Url("probe_reader", ""))).to.include({
      outcome: "refused",
      refusal: "sign-in-required",
    });
  });

  it("answers a database the server does not have, and one the account may not use", async () => {
    const missing = new URL(admin);
    missing.pathname = "/probe_missing";
    expect(await Probe(missing.toString())).to.include({
      outcome: "refused",
      refusal: "database",
    });
    expect(await Probe(Url(STRANGER))).to.include({
      outcome: "refused",
      refusal: "database-denied",
    });
  });

  it("answers a URL that names no database once the account has signed in", async () => {
    const answer = await Probe(Url("probe_reader", SECRET, ""));
    expect(answer).to.deep.include({
      outcome: "signed-in",
      user: "probe_reader@%",
      canRead: false,
      canWrite: false,
      unreadable: "no-database-named",
    });
  });
});
