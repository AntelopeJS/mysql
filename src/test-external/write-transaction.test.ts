import { expect } from "chai";
import {
  type Connection,
  type RowDataPacket,
  createConnection,
} from "mysql2/promise";
import type { Schema } from "@antelopejs/interface-database/schema";

import { GetOptions } from "../config";
import { Connect } from "../connection";
import { sql } from "../statement";
import { NativeWrite, RegisterSales, type SalesTables } from "./sales";

const ROW = sql`INSERT INTO sales.w_accounts (code, raw) VALUES ('txA', '{"k": "0"}')`;

const CLEAR = sql`DELETE FROM sales.w_accounts WHERE code LIKE 'tx%'`;

/** Over one lock wait of a second, and under three of them, which retries would take. */
const ONE_LOCK_WAIT_MS = 2_500;

/** A row of a global's value, read through the one column it names. */
interface GlobalRow extends RowDataPacket {
  readonly value: string | number;
}

let sales: Schema<SalesTables>;

/** Opens the pool again, so each connection starts from the server's current globals. */
async function Reconnect(): Promise<void> {
  const { url, catalog } = GetOptions();
  await Connect({ mode: "external", url, catalog });
}

function Accounts() {
  return sales
    .instance()
    .table("w_accounts")
    .filter((row) => row.key("code").eq("txA"));
}

/**
 * Sets the server's global `name` to `value` for the tests of the enclosing suite, on the admin
 * connection of `MYSQL_TEST_URL`, and sets it back after them. The suite is skipped without it.
 */
function WithGlobal(name: string, value: string | number): void {
  let admin: Connection | undefined;
  let saved: string | number | undefined;

  before(async function () {
    const url = process.env.MYSQL_TEST_URL;
    if (!url) {
      this.skip();
    }
    sales = await RegisterSales();
    admin = await createConnection(url);
    const [[row]] = await admin.query<GlobalRow[]>(
      `SELECT @@GLOBAL.${name} AS value`,
    );
    saved = row.value;
    await admin.query(`SET GLOBAL ${name} = ?`, [value]);
    await Reconnect();
  });

  beforeEach(async () => {
    await NativeWrite(CLEAR);
    await NativeWrite(ROW);
  });

  after(async () => {
    try {
      if (admin && saved !== undefined) {
        await admin.query(`SET GLOBAL ${name} = ?`, [saved]);
        await Reconnect();
        await NativeWrite(CLEAR);
      }
    } finally {
      await admin?.end();
    }
  });
}

describe("an external write where the server logs statements", function () {
  this.timeout(60_000);
  WithGlobal("binlog_format", "STATEMENT");

  /** Fails where the write runs at READ COMMITTED, which a statement-format binary log refuses. */
  it("updates and deletes as with any binary log format", async () => {
    const updated = await Accounts()
      .update({ raw: { k: "1" } })
      .run();
    const deleted = await Accounts().delete().run();
    expect({ updated, deleted }).to.deep.equal({ updated: 1, deleted: 1 });
  });

  /** Fails where the insert's refusal is the server's errno alone, which names no remedy. */
  it("refuses an insert with an error that names binlog_format and the formats it takes", async () => {
    const refusal = await sales
      .instance()
      .table("w_accounts")
      .insert({ code: "txB", raw: { k: "0" } })
      .run()
      .then(
        () => "inserted",
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
    expect({
      setting: refusal.includes("binlog_format"),
      remedy: refusal.includes("ROW or MIXED"),
    }).to.deep.equal({ setting: true, remedy: true });
  });
});

describe("an external update of a row another transaction holds", function () {
  this.timeout(60_000);
  WithGlobal("innodb_lock_wait_timeout", 1);

  /** Fails where a lock wait timeout runs the write again before it is refused. */
  it("is refused after one lock wait", async () => {
    const holder = await createConnection(GetOptions().url);
    try {
      await holder.query("START TRANSACTION");
      await holder.query(
        "SELECT code FROM sales.w_accounts WHERE code = 'txA' FOR UPDATE",
      );
      const started = Date.now();
      const refusal = await Accounts()
        .update({ raw: { k: "2" } })
        .run()
        .then(
          () => "updated",
          (err: unknown) => String(err),
        );
      expect({
        lockWait: /Lock wait timeout/.test(refusal),
        once: Date.now() - started < ONE_LOCK_WAIT_MS,
      }).to.deep.equal({ lockWait: true, once: true });
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
  });
});
