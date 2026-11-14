import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

import { type Sql, ident, join, param, sql } from "../statement";
import { PhysicalTable, Run } from "./tables";

const SCHEMA_ID = "equal_numbers";

/**
 * Spellings of JSON numbers another writer stores, which MySQL's JSON `=` and orderings tell apart
 * where a double holding both would not, or find equal where their text differs.
 */
const NUMBERS = [
  "18446744073709549568e0",
  "18446744073709550000",
  "18446744073709549568",
  "9223372036854774784e0",
  "9223372036854775000",
  "9223372036854774784",
  "-9223372036854775808",
  "-9223372036854775808e0",
  "100000000000000000001",
  "1e20",
  "1e19",
  "10000000000000000000",
  "9007199254740993",
  "9007199254740992e0",
  "1",
  "1.0",
  "0.1",
  "0.10000000000000001",
  "4e-324",
  "5e-324",
  "2e-324",
  "0",
  "1e-400",
  "18446744073709551615",
  "1.8446744073709552e19",
  "18446744073709551616",
] as const;

const SIGNED_MIN = -(2n ** 63n);
const UNSIGNED_MAX = 2n ** 64n - 1n;

/**
 * The value MySQL compares a number by: an integer literal from -2^63 to 2^64 - 1 exactly, and any
 * other number as the double it parses to, an integral one by the digits of its shortest decimal.
 * Each integral number of {@link NUMBERS} is below 10^21, which JavaScript writes without an exponent.
 */
function MysqlValue(text: string): bigint | number {
  if (/^-?[0-9]+$/.test(text)) {
    const exact = BigInt(text);
    if (exact >= SIGNED_MIN && exact <= UNSIGNED_MAX) {
      return exact;
    }
  }
  const double = Number(text);
  return Number.isInteger(double) ? BigInt(double.toString()) : double;
}

/** Whether MySQL finds two numbers equal: neither below the other. */
function Same(left: string, right: string): boolean {
  const [l, r] = [MysqlValue(left), MysqlValue(right)];
  return !(l < r) && !(l > r);
}

/** What `lt`, `eq`, `gt`, `le` and `ge` answer for two numbers, as MySQL compares them. */
function Order(left: string, right: string): string {
  const [l, r] = [MysqlValue(left), MysqlValue(right)];
  const same = Same(left, right);
  return JSON.stringify([l < r, same, l > r, l < r || same, l > r || same]);
}

interface Pair {
  _id: string;
  l?: number;
  r?: number;
}

interface Single {
  _id: string;
  n?: number;
}

const schema = new Schema<{ pairs: Pair; singles: Single }>(SCHEMA_ID, {
  pairs: { fields: {}, indexes: {} },
  singles: { fields: {}, indexes: {} },
});

/** Each ordered pair of numbers MySQL finds equal, as `left right` texts. */
const EQUAL = NUMBERS.flatMap((left) =>
  NUMBERS.filter((right) => Same(left, right)).map(
    (right) => `${left} ${right}`,
  ),
).sort();

/** The texts of the numbers at `indexes`, joined by a space. */
function Texts(indexes: readonly string[]): string {
  return indexes.map((index) => NUMBERS[Number(index)]).join(" ");
}

/** Rows of `table` with their `_id` and their undeclared keys, in the default instance. */
function Insert(table: string, rows: readonly (readonly [string, Sql])[]): Sql {
  const values = rows.map(([id, extra]) => sql`(${param(id)}, '', ${extra})`);
  return sql`INSERT INTO ${ident(PhysicalTable(SCHEMA_ID, table))} (_id, _instance, _extra) VALUES ${join(values, sql`, `)}`;
}

/** A number's JSON text as the server parses it. */
function Parsed(text: string): Sql {
  return sql`JSON_EXTRACT(${param(text)}, '$')`;
}

describe("eq on JSON numbers another writer spelled", function () {
  this.timeout(30_000);

  before(async () => {
    await schema.instance().table("pairs").delete().run();
    await schema.instance().table("singles").delete().run();
    await Run(
      Insert(
        "pairs",
        NUMBERS.flatMap((left, l) =>
          NUMBERS.map(
            (right, r) =>
              [
                `${l}-${r}`,
                sql`JSON_OBJECT('l', ${Parsed(left)}, 'r', ${Parsed(right)})`,
              ] as const,
          ),
        ),
      ),
    );
    await Run(
      Insert(
        "singles",
        NUMBERS.map(
          (number, index) =>
            [String(index), sql`JSON_OBJECT('n', ${Parsed(number)})`] as const,
        ),
      ),
    );
  });

  it("answers as MySQL's JSON = between two keys of a row", async () => {
    const ids = await schema
      .instance()
      .table("pairs")
      .filter((row) => row.key("l").eq(row.key("r")))
      .map((row) => row.key("_id"))
      .run();
    expect(ids.map((id) => Texts(id.split("-"))).sort()).to.deep.equal(EQUAL);
  });

  it("orders two keys of a row as MySQL's JSON orderings do", async () => {
    const rows = await schema
      .instance()
      .table("pairs")
      .map((row) => ({
        id: row.key("_id"),
        lt: row.key("l").lt(row.key("r")),
        eq: row.key("l").eq(row.key("r")),
        gt: row.key("l").gt(row.key("r")),
        le: row.key("l").le(row.key("r")),
        ge: row.key("l").ge(row.key("r")),
      }))
      .run();
    const read = rows
      .map(({ id, lt, eq, gt, le, ge }) => {
        const [left, right] = Texts(id.split("-")).split(" ");
        return `${left} ${right} ${JSON.stringify([lt, eq, gt, le, ge])}`;
      })
      .sort();
    const expected = NUMBERS.flatMap((left) =>
      NUMBERS.map((right) => `${left} ${right} ${Order(left, right)}`),
    ).sort();
    expect(read).to.deep.equal(expected);
  });

  it("answers as MySQL's JSON = in a join that hashes the key", async () => {
    const pairs = await schema
      .instance()
      .table("singles")
      .joinInner(
        schema.instance().table("singles"),
        (left, right) => left.key("n").eq(right.key("n")),
        (left, right) => ({ left: left.key("_id"), right: right.key("_id") }),
      )
      .run();
    expect(
      pairs.map(({ left, right }) => Texts([left, right])).sort(),
    ).to.deep.equal(EQUAL);
  });
});
