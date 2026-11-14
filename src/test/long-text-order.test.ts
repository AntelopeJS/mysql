import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "long_text_order";
const INSTANCE = "one";

interface Entry {
  _id: string;
  name: string;
}

const schema = new Schema<{ entries: Entry }>(SCHEMA_ID, {
  entries: { fields: { name: "string" }, indexes: {} },
});

/** More characters than MariaDB's sort with a `LIMIT` reads of a computed text. */
const SHARED = "x".repeat(2100);

const ROWS = 10;

/** A step coprime with {@link ROWS}, so the names' order is neither their rows' `_id` order nor its reverse. */
const STRIDE = 3;

/** Names that differ only past {@link SHARED}. */
const NAMES = Array.from(
  { length: ROWS },
  (_, n) => `${SHARED}${(n * STRIDE) % ROWS}`,
);

/** The rows' `_id` in their names' order. */
const BY_NAME = NAMES.map((name, n) => ({ id: `e${n}`, name }))
  .sort((a, b) => (a.name < b.name ? -1 : 1))
  .map((entry) => entry.id);

function Entries() {
  return schema.instance(INSTANCE).table("entries");
}

async function Seed(): Promise<void> {
  await schema.createInstance(INSTANCE).run();
  await Entries()
    .insert(NAMES.map((name, n) => ({ _id: `e${n}`, name })))
    .run();
}

async function Unseed(): Promise<void> {
  await schema.destroyInstance(INSTANCE).run();
}

/**
 * A sort that compares only the names' shared characters ties every row and keeps the rows in
 * their `_id` order, which is not their names' order.
 */
async function KeepsTheSlicedNames(): Promise<void> {
  const ids = await Entries()
    .orderBy("name")
    .slice(1, 3)
    .map((entry) => entry.key("_id"))
    .run();
  expect(ids).to.deep.equal(BY_NAME.slice(1, 4));
}

/** Every row, in a sort without a `LIMIT`, which reads more of each name but not all 2,100 characters by default. */
async function KeepsEveryRowInOrder(): Promise<void> {
  const ids = await Entries()
    .orderBy("name")
    .map((entry) => entry.key("_id"))
    .run();
  expect(ids).to.deep.equal(BY_NAME);
}

/** The same slice descending, whose rows a tie keeps in `_id` order as well. */
async function KeepsTheSlicedNamesDescending(): Promise<void> {
  const ids = await Entries()
    .orderBy("name", "desc")
    .slice(1, 3)
    .map((entry) => entry.key("_id"))
    .run();
  expect(ids).to.deep.equal([...BY_NAME].reverse().slice(1, 4));
}

describe("a slice of rows sorted by a long text", function () {
  before(Seed);

  after(Unseed);

  it("keeps the rows its whole names sort to", KeepsTheSlicedNames);

  it("keeps every row in its whole names' order", KeepsEveryRowInOrder);

  it(
    "keeps the rows its whole names sort to descending",
    KeepsTheSlicedNamesDescending,
  );
});
