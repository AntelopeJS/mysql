import { expect } from "chai";
import type { Schema } from "@antelopejs/interface-database/schema";

import { sql } from "../statement";
import { NativeWrite, RegisterSales, type SalesTables } from "./sales";

const FALLBACK = "fallback";

let sales: Schema<SalesTables>;

function Accounts() {
  return sales.instance().table("w_accounts");
}

async function Clear(): Promise<void> {
  await NativeWrite(
    sql`DELETE FROM sales.w_accounts WHERE code IN ('dn1', 'dn2', 'dn3', 'dn4')`,
  );
}

describe("default() over JSON text a client wrote to an external column", function () {
  this.timeout(30_000);
  before(async () => {
    sales = await RegisterSales();
    await Clear();
    await NativeWrite(
      sql`INSERT INTO sales.w_accounts (code, raw) VALUES ('dn1', ' null'), ('dn2', 'null\n'), ('dn3', '"null"'), ('dn4', ' "null" ')`,
    );
  });
  after(Clear);

  it('answers the default for a null with whitespace around it, and keeps a "null" string', async () => {
    const rows = await Accounts()
      .filter((row) => row.key("code").match("^dn[1-4]$"))
      .orderBy("code")
      .map((row) => ({
        code: row.key("code"),
        value: row.key("raw").default(FALLBACK),
      }))
      .run();
    expect(rows).to.deep.equal([
      { code: "dn1", value: FALLBACK },
      { code: "dn2", value: FALLBACK },
      { code: "dn3", value: "null" },
      { code: "dn4", value: "null" },
    ]);
  });
});
