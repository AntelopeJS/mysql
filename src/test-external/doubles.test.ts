import { expect } from "chai";
import type { Schema } from "@antelopejs/interface-database/schema";

import { param, sql } from "../statement";
import { Native, NativeWrite, RegisterSales, type SalesTables } from "./sales";

/**
 * Doubles MySQL 8.4's JSON text parser reads as a neighbour or as another number: a 17-digit
 * double, a sum that is not its decimal, the least subnormal, the greatest double and a negative
 * zero, which JSON text spells `0`.
 */
const DOUBLES = [
  123456789.12345679,
  0.1 + 0.2,
  5e-324,
  1.7976931348623157e308,
  -0,
];

const RAW = { list: DOUBLES, long: DOUBLES[0], zero: -0 };

let sales: Schema<SalesTables>;

function Accounts() {
  return sales.instance().table("w_accounts");
}

/** The JSON column as the server prints it, which spells each double it holds exactly. */
async function PrintedRaw(id: string): Promise<string> {
  const [row] = await Native(
    sql`SELECT CAST(raw AS CHAR) AS raw FROM sales.w_accounts WHERE id = ${param(id)}`,
  );
  return String(row?.raw);
}

describe("a double written into an external JSON column", function () {
  this.timeout(30_000);
  before(async () => {
    sales = await RegisterSales();
    await NativeWrite(
      sql`DELETE FROM sales.w_accounts WHERE code IN ('dbl1', 'dbl2', 'dbl3')`,
    );
  });

  it("is stored exactly by an insert", async () => {
    const [id] = await Accounts().insert({ code: "dbl1", raw: RAW }).run();
    expect((await Accounts().get(id).run())?.raw).to.deep.equal(RAW);
    expect(JSON.parse(await PrintedRaw(id))).to.deep.equal(RAW);
  });

  it("is stored exactly by an update", async () => {
    const [id] = await Accounts().insert({ code: "dbl2" }).run();
    expect(await Accounts().get(id).update({ raw: RAW }).run()).to.equal(1);
    expect((await Accounts().get(id).run())?.raw).to.deep.equal(RAW);
    expect(JSON.parse(await PrintedRaw(id))).to.deep.equal(RAW);
  });

  it("is stored exactly by a replace", async () => {
    const [id] = await Accounts().insert({ code: "dbl3" }).run();
    expect(
      await Accounts().get(id).replace({ code: "dbl3", raw: RAW }).run(),
    ).to.equal(1);
    expect((await Accounts().get(id).run())?.raw).to.deep.equal(RAW);
    expect(JSON.parse(await PrintedRaw(id))).to.deep.equal(RAW);
  });
});
