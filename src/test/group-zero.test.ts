import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "group_zero";
const INSTANCE = "one";

interface Reading {
  _id: string;
  n: number;
  k: number;
  loose: number | string;
  label: string;
  list: number[];
}

const schema = new Schema<{ readings: Reading }>(SCHEMA_ID, {
  readings: {
    fields: { n: "number", k: "number", label: "string", list: "number[]" },
    indexes: {
      byN: { fields: ["n"] },
      byNK: { fields: ["n", "k"] },
      byNLoose: { fields: ["n", "loose"] },
      byNLabel: { fields: ["n", "label"] },
      byNList: { fields: ["n", "list"] },
    },
  },
});

function Readings() {
  return schema.instance(INSTANCE).table("readings");
}

/**
 * 0 and -0 in a declared number and in an undeclared field: one value, so one group, alone or beside
 * a declared string or list in a compound key. The string `"0"` in the undeclared field is another
 * value, which no group may merge with the number 0.
 */
const ROWS: Reading[] = [
  { _id: "negative", n: -0, k: 5, loose: -0, label: "a", list: [1] },
  { _id: "positive", n: 0, k: 5, loose: 0, label: "a", list: [1] },
  { _id: "one", n: 1, k: 5, loose: 1, label: "a", list: [1] },
  { _id: "text", n: 2, k: 5, loose: "0", label: "a", list: [1] },
];

const KEYS = [
  "n",
  "loose",
  "byN",
  "byNK",
  "byNLoose",
  "byNLabel",
  "byNList",
] as const;

/** Each group's size, smallest first. */
async function GroupSizes(key: (typeof KEYS)[number]): Promise<number[]> {
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

  for (const key of ["n", "byN"] as const) {
    it(`hands the mapper 0 as the ${key} key of a declared number's zeros, -0 stored first`, async () => {
      const groups = await Readings()
        .group(key, (rows, value) => ({ value, size: rows.count() }))
        .run();
      const zeros = groups.find((group) => group.size === 2);
      expect(Object.is(zeros?.value, 0), String(zeros?.value)).to.equal(true);
    });
  }

  const COMPOUND_ZEROS = {
    byNK: { n: 0, k: 5 },
    byNLabel: { n: 0, label: "a" },
    byNList: { n: 0, list: [1] },
  };

  for (const [key, expected] of Object.entries(COMPOUND_ZEROS)) {
    it(`hands the mapper 0 as the number in the ${key} key, -0 stored first`, async () => {
      const groups = await Readings()
        .group(key, (rows, value) => ({ value, size: rows.count() }))
        .run();
      const zeros = groups.find((group) => group.size === 2);
      expect(zeros?.value).to.deep.equal(expected);
    });
  }

  for (const key of KEYS) {
    it(`puts 0 and -0 in one group by ${key}`, async () => {
      expect(await GroupSizes(key)).to.deep.equal([1, 1, 2]);
    });
  }
});
