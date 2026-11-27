import { expect } from "chai";
import type { Schema } from "@antelopejs/interface-database/schema";

import { GetDialect } from "../connection";
import { param, sql } from "../statement";
import { Native, NativeWrite, RegisterSales, type SalesTables } from "./sales";

/** An object nesting 30 objects, so a row holding it under a key has `JSON_DEPTH` 32. */
function Nested(): string {
  let value = "1";
  for (let level = 0; level < 30; level += 1) {
    value = `{"n": ${value}}`;
  }
  return value;
}

/**
 * Rows another writer stores: one a merge reads, and one whose `raw` spells `é` twice at
 * `JSON_DEPTH` 32, whose members MariaDB 11.8 cannot list.
 */
const ROWS = sql`INSERT INTO sales.w_accounts (code, raw) VALUES ('dmA', '{"k": "0"}'), ('dmB', ${param(`{"\\u00e9": "x", "\\u00e9": ${Nested()}}`)})`;

const CLEAR = sql`DELETE FROM sales.w_accounts WHERE code LIKE 'dm%'`;

let sales: Schema<SalesTables>;

async function Left(): Promise<string[]> {
  const rows = await Native(
    sql`SELECT code FROM sales.w_accounts WHERE code LIKE 'dm%' ORDER BY code`,
  );
  return rows.map((row) => String(row.code));
}

describe("an external write filtered on a merge of a deep operand that spells a key twice", function () {
  this.timeout(30_000);

  before(async () => {
    sales = await RegisterSales();
    await NativeWrite(CLEAR);
    await NativeWrite(ROWS);
  });

  after(async () => {
    await NativeWrite(CLEAR);
  });

  it("deletes the rows it matches, or fails as nested too deep and deletes none", async () => {
    const answer = await sales
      .instance()
      .table("w_accounts")
      .filter((row) =>
        row
          .key("code")
          .match("^dm[AB]$")
          .and(row.key("raw").merge({ z: "1" }).key("z").eq("1")),
      )
      .delete()
      .run()
      .catch((err: unknown) =>
        err instanceof Error && GetDialect().capture.tooDeep(err)
          ? "too deep"
          : String(err),
      );
    expect(answer).to.be.oneOf([2, "too deep"]);
    expect(await Left()).to.deep.equal(answer === 2 ? [] : ["dmA", "dmB"]);
  });
});
