import { expect } from "chai";
import type { Schema } from "@antelopejs/interface-database/schema";

import { sql } from "../statement";
import { NativeWrite, RegisterSales, type SalesTables } from "./sales";

/**
 * Spellings of 0, 1, 1.5, 1e20 and the greatest double another writer stores in a JSON column: MySQL parses
 * text into integers and doubles and keeps an SQL decimal as a decimal, MariaDB keeps each one's
 * text.
 */
const SPELLINGS = sql`INSERT INTO sales.w_accounts (code, raw) VALUES
  ('jn1', '0'), ('jn2', '0.0'), ('jn3', '-0.0'), ('jn4', '1'), ('jn5', '1.0'),
  ('jn6', JSON_EXTRACT(JSON_ARRAY(0.0), '$[0]')), ('jn7', JSON_EXTRACT(JSON_ARRAY(1.0), '$[0]')),
  ('jn8', '1.7976931348623157e308'), ('jn9', '17976931348623157e292'),
  ('jn10', '1e20'), ('jn11', '100000000000000000000'),
  ('jn12', JSON_EXTRACT(JSON_ARRAY(1.5), '$[0]')), ('jn13', JSON_EXTRACT(JSON_ARRAY(1.50), '$[0]'))`;

const EXPECTED = [Sorted([0, 1, 1.5, 1e20, Number.MAX_VALUE]), 5];

const CODES = "^jn";

let sales: Schema<SalesTables>;

function Spelled() {
  return sales
    .instance()
    .table("w_accounts")
    .filter((row) => row.key("code").match(CODES));
}

function Sorted(values: readonly unknown[] | undefined): unknown[] {
  return [...(values ?? [])].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

describe("a dedup of external JSON number spellings", function () {
  this.timeout(30_000);

  before(async () => {
    sales = await RegisterSales();
    await NativeWrite(sql`DELETE FROM sales.w_accounts WHERE code LIKE 'jn%'`);
    await NativeWrite(SPELLINGS);
  });

  after(async () => {
    await NativeWrite(sql`DELETE FROM sales.w_accounts WHERE code LIKE 'jn%'`);
  });

  it("keeps one value per number at the top", async () => {
    const values = await Spelled().distinct("raw").run();
    const count = await Spelled().distinct("raw").count().run();
    expect([Sorted(values), count]).to.deep.equal(EXPECTED);
  });

  it("keeps one value per number in a group", async () => {
    const [group] = await Spelled()
      .group("status", (stream, status) => ({
        status,
        values: stream.distinct("raw"),
        count: stream.distinct("raw").count(),
      }))
      .run();
    expect([Sorted(group?.values), group?.count]).to.deep.equal(EXPECTED);
  });
});
