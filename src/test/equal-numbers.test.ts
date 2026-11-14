import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

import { type Sql, ident, join, param, sql } from "../statement";
import { PhysicalTable, Run } from "./tables";

const SCHEMA_ID = "equal_numbers";

/**
 * JSON numbers another writer stores, each in the class of the numbers MySQL's JSON `=` finds it
 * equal to: MySQL reads an integer literal from -2^63 to 2^64 - 1 as an integer and any other
 * number as a double, and finds an integer equal to a double where the double's shortest decimal
 * has the integer's digits.
 */
const NUMBERS: readonly (readonly [string, string])[] = [
  ["18446744073709549568e0", "a"],
  ["18446744073709550000", "a"],
  ["18446744073709549568", "b"],
  ["9223372036854774784e0", "c"],
  ["9223372036854775000", "c"],
  ["9223372036854774784", "d"],
  ["-9223372036854775808", "e"],
  ["-9223372036854775808e0", "f"],
  ["100000000000000000001", "g"],
  ["1e20", "g"],
  ["1e19", "h"],
  ["10000000000000000000", "h"],
  ["9007199254740993", "i"],
  ["9007199254740992e0", "j"],
  ["1", "k"],
  ["1.0", "k"],
];

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
const EQUAL = NUMBERS.flatMap(([left, leftClass]) =>
  NUMBERS.filter(([, rightClass]) => rightClass === leftClass).map(
    ([right]) => `${left} ${right}`,
  ),
).sort();

/** The texts of the numbers at `indexes`, joined by a space. */
function Texts(indexes: readonly string[]): string {
  return indexes.map((index) => NUMBERS[Number(index)]?.[0]).join(" ");
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
        NUMBERS.flatMap(([left], l) =>
          NUMBERS.map(
            ([right], r) =>
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
          ([number], index) =>
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
