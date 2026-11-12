import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "nested_sort";
const INSTANCE = "one";

interface Book {
  _id: string;
  title: { fr: string };
  _internal: { data: { title: { fr: string } } };
}

const schema = new Schema<{ books: Book }>(SCHEMA_ID, {
  books: { fields: { title: "object" }, indexes: {} },
});

/** Ids in one order, both titles in the reverse one, so a sort that ties answers the id order. */
const BOOKS: Book[] = ["a", "b", "c", "d", "e"].map((id, at) => {
  const fr = `titre ${String(9 - at)}`;
  return { _id: id, title: { fr }, _internal: { data: { title: { fr } } } };
});

function Books() {
  return schema.instance(INSTANCE).table("books");
}

async function SortedIds(name: string): Promise<string[]> {
  const books = await Books().orderBy(name).run();
  return books.map((book) => book._id);
}

describe("a sort by a dotted name that no field or index declares", function () {
  this.timeout(60_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Books().insert(BOOKS).run();
  });

  it("reads the name as a path below a declared field, not as one literal key", async () => {
    expect(await SortedIds("title.fr")).to.deep.equal([
      "e",
      "d",
      "c",
      "b",
      "a",
    ]);
  });

  it("reads the name as a path below the overflow column, not as one literal key", async () => {
    expect(await SortedIds("_internal.data.title.fr")).to.deep.equal([
      "e",
      "d",
      "c",
      "b",
      "a",
    ]);
  });
});
