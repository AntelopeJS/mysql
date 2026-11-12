import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "nth_after_slice";
const INSTANCE = "one";

interface Item {
  _id: string;
  slug: string;
}

interface Owner {
  _id: string;
  at: number;
}

const schema = new Schema<{ items: Item; owners: Owner }>(SCHEMA_ID, {
  items: { fields: { slug: "string" }, indexes: {} },
  owners: { fields: { at: "number" }, indexes: {} },
});

function Items() {
  return schema.instance(INSTANCE).table("items");
}

function Owners() {
  return schema.instance(INSTANCE).table("owners");
}

const SLUGS = Array.from(
  { length: 20 },
  (_, n) => `s${String(n).padStart(2, "0")}`,
);

/** Indexes into the slice: its first row, its middle, its last, and one past its end. */
const INDEXES = [0, 1, 4, 8, 9];

const SLICE_OFFSET = 2;
const SLICE_COUNT = 9;

async function Seed(): Promise<void> {
  await schema.createInstance(INSTANCE).run();
  await Items()
    .insert(SLUGS.map((slug, n) => ({ _id: `i${n}`, slug })))
    .run();
  await Owners()
    .insert(INDEXES.map((at) => ({ _id: `o${at}`, at })))
    .run();
}

async function NthByOuterIndex(): Promise<void> {
  const picked = await Owners()
    .map((owner) => ({
      at: owner.key("at"),
      slug: Items()
        .orderBy("slug")
        .slice(SLICE_OFFSET, SLICE_COUNT)
        .nth(owner.key("at"))
        .key("slug"),
    }))
    .run();
  const sliced = SLUGS.slice(SLICE_OFFSET, SLICE_OFFSET + SLICE_COUNT);
  expect(picked).to.have.deep.members(
    INDEXES.map((at) => ({ at, slug: sliced[at] ?? null })),
  );
}

async function NthByOuterCount(): Promise<void> {
  const picked = await Owners()
    .map((owner) => ({
      at: owner.key("at"),
      slug: Items()
        .orderBy("slug", "desc")
        .slice(SLICE_OFFSET, SLICE_COUNT)
        .nth(
          Owners()
            .filter((other) => other.key("at").lt(owner.key("at")))
            .count(),
        )
        .key("slug"),
    }))
    .run();
  const sliced = [...SLUGS]
    .reverse()
    .slice(SLICE_OFFSET, SLICE_OFFSET + SLICE_COUNT);
  expect(picked).to.have.deep.members(
    INDEXES.map((at, below) => ({ at, slug: sliced[below] ?? null })),
  );
}

describe("nth of a constant slice, at an index the outer row computes", function () {
  this.timeout(60_000);

  before(Seed);

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  it("picks the row at a field of the outer row", NthByOuterIndex);
  it(
    "picks the row at a count that reads the outer row, in descending order",
    NthByOuterCount,
  );
});
