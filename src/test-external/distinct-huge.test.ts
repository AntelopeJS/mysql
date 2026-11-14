import { expect } from "chai";
import type { Schema } from "@antelopejs/interface-database/schema";

import { param, sql } from "../statement";
import { NativeWrite, RegisterSales, type SalesTables } from "./sales";

/** Elements of each document, which fill 4.4 MB of text, more than a ninth of `max_allowed_packet`. */
const ELEMENTS = 2_200_000;

/** Two documents that differ in every element, each an object around an array of one digit. */
const DIGITS = [1, 2];

const CODES = "^jh";

/** The text of the document of `digit`, which `JSON.stringify` writes back the same. */
function Document(digit: number): string {
  return `{"a":[${Array.from({ length: ELEMENTS }, () => digit).join(",")}]}`;
}

let sales: Schema<SalesTables>;

function Huge() {
  return sales
    .instance()
    .table("w_accounts")
    .filter((row) => row.key("code").match(CODES));
}

describe("a dedup of huge external JSON documents", function () {
  this.timeout(120_000);

  before(async () => {
    sales = await RegisterSales();
    await NativeWrite(sql`DELETE FROM sales.w_accounts WHERE code LIKE 'jh%'`);
    for (const digit of DIGITS) {
      await NativeWrite(
        sql`INSERT INTO sales.w_accounts (code, raw) VALUES (${param(`jh${digit}`)}, ${param(Document(digit))})`,
      );
    }
  });

  after(async () => {
    await NativeWrite(sql`DELETE FROM sales.w_accounts WHERE code LIKE 'jh%'`);
  });

  it("keeps each document whole", async () => {
    const values = await Huge().distinct("raw").run();
    const texts = values.map((value) => JSON.stringify(value)).sort();
    expect(texts).to.deep.equal(DIGITS.map(Document));
  });
});
