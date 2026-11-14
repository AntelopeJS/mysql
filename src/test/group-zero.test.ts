import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "group_zero";
const INSTANCE = "one";

interface Reading {
  _id: string;
  n: number;
  loose: number | string;
}

const schema = new Schema<{ readings: Reading }>(SCHEMA_ID, {
  readings: {
    fields: { n: "number" },
    indexes: { byN: { fields: ["n"] } },
  },
});

function Readings() {
  return schema.instance(INSTANCE).table("readings");
}

/**
 * 0 and -0 in a declared number and in an undeclared field: one value, so one group. The string
 * `"0"` in the undeclared field is another value, which no group may merge with the number 0.
 */
const ROWS: Reading[] = [
  { _id: "negative", n: -0, loose: -0 },
  { _id: "positive", n: 0, loose: 0 },
  { _id: "one", n: 1, loose: 1 },
  { _id: "text", n: 2, loose: "0" },
];

/** Each group's size, smallest first. */
async function GroupSizes(key: "n" | "loose" | "byN"): Promise<number[]> {
  const groups = await Readings()
    .group(key, (rows) => ({ size: rows.count() }))
    .run();
  return groups.map((group) => group.size).sort((a, b) => a - b);
}

describe("a group key of 0 and -0", function () {
  this.timeout(30_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Readings().insert(ROWS).run();
  });

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  it("hands the mapper 0 as the key of an undeclared field's zeros, -0 stored first", async () => {
    const groups = await Readings()
      .group("loose", (rows, key) => ({ key, size: rows.count() }))
      .run();
    const zeros = groups.find((group) => group.size === 2);
    expect(Object.is(zeros?.key, 0), String(zeros?.key)).to.equal(true);
  });

  for (const key of ["n", "loose", "byN"] as const) {
    it(`puts 0 and -0 in one group by ${key}`, async () => {
      expect(await GroupSizes(key)).to.deep.equal([1, 1, 2]);
    });
  }
});
