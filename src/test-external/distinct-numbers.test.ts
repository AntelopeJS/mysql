import { expect } from "chai";
import type { Schema } from "@antelopejs/interface-database/schema";

import { sql } from "../statement";
import { NativeWrite, RegisterSales, type SalesTables } from "./sales";

/**
 * Spellings of 0, 1, 1.5, 1e19, 1e20, the greatest double below 2^64, 2^64 and 2^64 - 1, 1e35, 2e35, the greatest double and a 1 nested in an array or an
 * object, and a 1 with an exponent nested in an array or an object, another writer stores in a JSON column: MySQL parses text into integers and doubles and
 * keeps an SQL decimal as a decimal, MariaDB keeps each one's text. Beside them, objects that a `JSON_NORMALIZE` of every object would break:
 * a key with an escaped quote or line feed, which MariaDB 12.3 writes back unescaped, and a key named twice, at the top and nested, whose
 * members both versions reorder, so that `{"r": 2, "r": 1}` would read 2 and meet `{"r": 1, "r": 2}`. MySQL keeps the last member.
 */
const SPELLINGS = sql`INSERT INTO sales.w_accounts (code, raw) VALUES
  ('jn1', '0'), ('jn2', '0.0'), ('jn3', '-0.0'), ('jn4', '1'), ('jn5', '1.0'),
  ('jn6', JSON_EXTRACT(JSON_ARRAY(0.0), '$[0]')), ('jn7', JSON_EXTRACT(JSON_ARRAY(1.0), '$[0]')),
  ('jn8', '1.7976931348623157e308'), ('jn9', '17976931348623157e292'),
  ('jn10', '1e20'), ('jn11', '100000000000000000000'),
  ('jn12', JSON_EXTRACT(JSON_ARRAY(1.5), '$[0]')), ('jn13', JSON_EXTRACT(JSON_ARRAY(1.50), '$[0]')),
  ('jn14', JSON_EXTRACT(JSON_ARRAY(100000000000000000000000000000000000), '$[0]')),
  ('jn15', JSON_EXTRACT(JSON_ARRAY(200000000000000000000000000000000000), '$[0]')),
  ('jn16', '[1]'), ('jn17', '[1.0]'), ('jn18', '{"a": 1}'), ('jn19', '{"a": 1.0}'),
  ('jn20', '["1.0"]'), ('jn21', '["1"]'), ('jn22', '[1.05]'), ('jn23', '[1.5]'),
  ('jn24', '1e19'), ('jn25', '10000000000000000000'),
  ('jn26', JSON_EXTRACT(JSON_ARRAY(10000000000000000000.0), '$[0]')),
  ('jn27', '18446744073709549568e0'), ('jn28', '18446744073709550000'),
  ('jn29', '1.8446744073709552e19'), ('jn30', '18446744073709551615'),
  ('jn31', '[1e0]'), ('jn32', '[10e-1]'),
  ('jn33', '[1e19]'), ('jn34', '[10000000000000000000]'),
  ('jn35', '[1e18]'), ('jn36', '[1000000000000000000]'),
  ('jn37', '[1.5e15]'), ('jn38', '[1500000000000000]'),
  ('jn39', '{"a": 1e0}'),
  ('jn40', '{"a\\\\"b": 1}'), ('jn41', '{"a\\\\nb": 1}'),
  ('jn42', '{"r": 2, "r": 1}'), ('jn43', '{"r": 1, "r": 2}'), ('jn44', '[{"r": 2, "r": 1}]')`;

const EXPECTED = [
  Sorted([
    0,
    1,
    1.5,
    1e19,
    1e20,
    18446744073709550000,
    2 ** 64,
    2 ** 64,
    1e35,
    2e35,
    Number.MAX_VALUE,
    [1],
    { a: 1 },
    ["1.0"],
    ["1"],
    [1.05],
    [1.5],
    [1e19],
    [1e18],
    [1.5e15],
    { 'a"b': 1 },
    { "a\nb": 1 },
    { r: 1 },
    { r: 2 },
    [{ r: 1 }],
  ]),
  25,
];

const CODES = "^jn";

const SPELLED_ROWS = 44;

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
        rows: stream.count(),
      }))
      .run();
    expect([Sorted(group?.values), group?.count]).to.deep.equal(EXPECTED);
    expect(group?.rows).to.equal(SPELLED_ROWS);
  });
});
