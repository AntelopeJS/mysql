import { expect } from "chai";
import { type RowDataPacket, createConnection } from "mysql2/promise";
import { randomBytes } from "node:crypto";
import os from "node:os";

import { GetOptions } from "../config";
import { DetectDialect } from "../dialect";
import { probe } from "../probe";
import { TIMEOUT_MS, Unaborted } from "./unit/probe-fixture";

const DATABASE = "probe_accounts";
const SECRET = randomBytes(6).toString("hex");
/** A user name no account has, which the server signs in through its anonymous account. */
const NOBODY = `probe_nobody_${randomBytes(3).toString("hex")}`;
/** The server's own socket, for a test run that can reach it, as `scripts/test.sh` does not. */
const SOCKET = process.env.MYSQL_TEST_SOCKET;

describe("probe, naming the account the server signed it in as", function () {
  this.timeout(30_000);
  const admin = new URL(GetOptions().url ?? "");

  async function AsAdmin(statements: readonly string[]) {
    const connection = await createConnection(admin.toString());
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT VERSION() AS version",
      );
      for (const statement of statements) {
        await connection.query(statement);
      }
      return DetectDialect(String(rows[0]?.version));
    } finally {
      await connection.end();
    }
  }

  before(() =>
    AsAdmin([
      `DROP DATABASE IF EXISTS ${DATABASE}`,
      `CREATE DATABASE ${DATABASE}`,
      `CREATE TABLE ${DATABASE}.t (id INT PRIMARY KEY)`,
    ]),
  );
  after(() => AsAdmin([`DROP DATABASE IF EXISTS ${DATABASE}`]));

  it("answers the server's account, not the URL's user, when the server signs in another account", async () => {
    const anonymous = "''@'%'";
    try {
      await AsAdmin([
        `DROP USER IF EXISTS ${anonymous}`,
        `CREATE USER ${anonymous} IDENTIFIED BY '${SECRET}'`,
        `GRANT SELECT ON ${DATABASE}.* TO ${anonymous}`,
      ]);
      const answer = await probe({
        url: `mysql://${NOBODY}:${SECRET}@${admin.hostname}:${admin.port || 3306}/${DATABASE}`,
        timeoutMs: TIMEOUT_MS,
        signal: Unaborted(),
      });
      expect(answer).to.include({
        outcome: "signed-in",
        user: "@%",
        canRead: true,
      });
    } finally {
      await AsAdmin([`DROP USER IF EXISTS ${anonymous}`]);
    }
  });

  it("answers the account a local socket signed in by the process's OS user, whatever password the URL gives", async function () {
    if (SOCKET === undefined) {
      this.skip();
    }
    const user = os.userInfo().username;
    const account = `'${user}'@'localhost'`;
    try {
      await AsAdmin([`DROP USER IF EXISTS ${account}`]).then((engine) =>
        AsAdmin(
          engine === "mariadb"
            ? [`CREATE USER ${account} IDENTIFIED VIA unix_socket`]
            : [
                "INSTALL PLUGIN auth_socket SONAME 'auth_socket.so'",
                `CREATE USER ${account} IDENTIFIED WITH auth_socket`,
              ],
        ).catch(() =>
          AsAdmin([`CREATE USER ${account} IDENTIFIED WITH auth_socket`]),
        ),
      );
      await AsAdmin([`GRANT SELECT ON ${DATABASE}.* TO ${account}`]);
      const answer = await probe({
        url: `mysql://${user}:wrong-${SECRET}@localhost/${DATABASE}?socketPath=${encodeURIComponent(SOCKET)}`,
        timeoutMs: TIMEOUT_MS,
        signal: Unaborted(),
      });
      expect(answer).to.include({
        outcome: "signed-in",
        user: `${user}@localhost`,
        canRead: true,
      });
    } finally {
      await AsAdmin([`DROP USER IF EXISTS ${account}`]);
    }
  });
});
