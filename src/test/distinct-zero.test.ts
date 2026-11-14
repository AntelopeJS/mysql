import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "distinct_zero";
const INSTANCE = "one";

interface Reading {
  _id: string;
  kind: string;
  declared: number;
  loose: number | string;
}

const schema = new Schema<{ readings: Reading }>(SCHEMA_ID, {
  readings: {
    fields: { kind: "string", declared: "number" },
    indexes: {},
  },
});

function Readings() {
  return schema.instance(INSTANCE).table("readings");
}

/**
 * One kind holding 0 and -0 in a declared number and in an undeclared field, and the string `"0"`
 * in the undeclared one, which no dedup may merge with the number 0.
 */
const ROWS: Reading[] = [
  { _id: "positive", kind: "a", declared: 0, loose: 0 },
  { _id: "negative", kind: "a", declared: -0, loose: -0 },
  { _id: "text", kind: "a", declared: 0, loose: "0" },
];

type Field = "declared" | "loose";

type Value = Reading[Field];

const EXPECTED: Record<Field, Value[]> = {
  declared: [0],
  loose: ["0", 0],
};

/** Orders values by their JSON text, a string's quote before a digit, so two dedups compare as arrays. */
function ByText(left: Value, right: Value): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

async function TopLevel(field: Field): Promise<Value[]> {
  const read = await Readings().distinct(field).run();
  return [...read].sort(ByText);
}

async function InGroup(field: Field): Promise<Value[]> {
  const [group] = await Readings()
    .group("kind", (stream, kind) => ({ kind, values: stream.distinct(field) }))
    .run();
  return [...(group?.values ?? [])].sort(ByText);
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
async function Mapped(field: Field): Promise<Value[][]> {
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
  return [[...top].sort(ByText), [...(group?.values ?? [])].sort(ByText)];
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

  for (const field of ["declared", "loose"] as const) {
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
