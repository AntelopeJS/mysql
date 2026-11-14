import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "distinct_zero";
const INSTANCE = "one";

interface Reading {
  _id: string;
  kind: string;
  declared: number;
  loose: number | string;
  list: (number | string)[];
  record: { a: number | string };
  numbers: number[];
  pair: { a: number };
}

const schema = new Schema<{ readings: Reading }>(SCHEMA_ID, {
  readings: {
    fields: {
      kind: "string",
      declared: "number",
      numbers: "number[]",
      pair: { a: "number" },
    },
    indexes: {},
  },
});

function Readings() {
  return schema.instance(INSTANCE).table("readings");
}

/**
 * One kind holding 0 and -0 in a declared number, in an undeclared field, and nested in an array and
 * an object, undeclared and declared, and the string `"0"` in the undeclared ones, which no dedup may
 * merge with the number 0.
 */
const ROWS: Reading[] = [
  {
    _id: "positive",
    kind: "a",
    declared: 0,
    loose: 0,
    list: [0],
    record: { a: 0 },
    numbers: [0],
    pair: { a: 0 },
  },
  {
    _id: "negative",
    kind: "a",
    declared: -0,
    loose: -0,
    list: [-0],
    record: { a: -0 },
    numbers: [-0],
    pair: { a: -0 },
  },
  {
    _id: "text",
    kind: "a",
    declared: 0,
    loose: "0",
    list: ["0"],
    record: { a: "0" },
    numbers: [1],
    pair: { a: 1 },
  },
];

const FIELDS = [
  "declared",
  "loose",
  "list",
  "record",
  "numbers",
  "pair",
] as const;

type Field = (typeof FIELDS)[number];

type Value = Reading[Field];

/**
 * The JSON text of each value a dedup keeps, a string's quote before a digit. Of two equal containers
 * MySQL keeps either, and the text spells a nested -0 as `0`; a top-level -0 reads `-0`.
 */
const EXPECTED: Record<Field, string[]> = {
  declared: ["0"],
  loose: ['"0"', "0"],
  list: ['["0"]', "[0]"],
  record: ['{"a":"0"}', '{"a":0}'],
  numbers: ["[0]", "[1]"],
  pair: ['{"a":0}', '{"a":1}'],
};

/** The JSON text of each value a dedup kept, in order, with a top-level -0 spelled `-0`. */
function Kept(values: readonly Value[]): string[] {
  return values
    .map((value) => (Object.is(value, -0) ? "-0" : JSON.stringify(value)))
    .sort();
}

async function TopLevel(field: Field): Promise<string[]> {
  const read = await Readings().distinct(field).run();
  return Kept(read);
}

async function InGroup(field: Field): Promise<string[]> {
  const [group] = await Readings()
    .group("kind", (stream, kind) => ({ kind, values: stream.distinct(field) }))
    .run();
  return Kept(group?.values ?? []);
}

async function TopLevelCount(field: Field): Promise<number> {
  return Readings().distinct(field).count().run();
}

async function InGroupCount(field: Field): Promise<number | undefined> {
  const [group] = await Readings()
    .group("kind", (stream, kind) => ({
      kind,
      count: stream.distinct(field).count(),
    }))
    .run();
  return group?.count;
}

/** A field read by a `map`, then deduped whole: the dedup of a value rather than of a named field. */
async function Mapped(field: Field): Promise<string[][]> {
  const top = await Readings()
    .map((reading) => reading.key(field))
    .distinct()
    .run();
  const [group] = await Readings()
    .group("kind", (stream, kind) => ({
      kind,
      values: stream.map((reading) => reading.key(field)).distinct(),
    }))
    .run();
  return [Kept(top), Kept(group?.values ?? [])];
}

describe("a dedup of 0 and -0", function () {
  this.timeout(30_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Readings().insert(ROWS).run();
  });

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  for (const field of FIELDS) {
    it(`keeps one 0 of a ${field} field at the top`, async () => {
      expect(await TopLevel(field)).to.deep.equal(EXPECTED[field]);
    });

    it(`keeps one 0 of a ${field} field in a group`, async () => {
      expect(await InGroup(field)).to.deep.equal(EXPECTED[field]);
    });

    it(`counts one 0 of a ${field} field at the top and in a group`, async () => {
      const counts = [await TopLevelCount(field), await InGroupCount(field)];
      expect(counts).to.deep.equal([
        EXPECTED[field].length,
        EXPECTED[field].length,
      ]);
    });

    it(`keeps one 0 of a ${field} field a map reads, at the top and in a group`, async () => {
      expect(await Mapped(field)).to.deep.equal([
        EXPECTED[field],
        EXPECTED[field],
      ]);
    });
  }
});

/**
 * An array whose JSON text runs past the length up to which a dedup key respells its zeros; MySQL
 * stops a regular expression over text this long.
 */
const LONG: Reading = {
  _id: "long",
  kind: "b",
  declared: 0,
  loose: 0,
  list: Array.from({ length: 40_000 }, () => 1),
  record: { a: 0 },
  numbers: [0],
  pair: { a: 0 },
};

describe("a dedup of an array past the respelled length", function () {
  this.timeout(30_000);

  const instance = "long";

  function LongReadings() {
    return schema.instance(instance).table("readings");
  }

  before(async () => {
    await schema.createInstance(instance).run();
    await LongReadings()
      .insert([LONG, { ...LONG, _id: "copy" }])
      .run();
  });

  after(async () => {
    await schema.destroyInstance(instance).run();
  });

  it("keeps one copy of it in a group", async () => {
    const [group] = await LongReadings()
      .group("kind", (stream, kind) => ({
        kind,
        lists: stream.distinct("list"),
      }))
      .run();
    expect(group?.lists).to.deep.equal([LONG.list]);
  });
});
