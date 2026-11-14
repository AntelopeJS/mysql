import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

const INSTANCE = "one";

type Doc = Record<string, string | number | string[]> & {
  _id: string;
  list: string[];
};

const DOCS: Doc[] = [
  { _id: "over", list: ["a", "b"], a: 2, b: 3 },
  { _id: "under", list: ["a", "b"], a: 1, b: 1 },
  { _id: "missing", list: ["a", "z"], a: 4 },
  { _id: "empty", list: [], a: 9 },
];

const schema = new Schema<{ rows: Doc }>("outer_row_mapped_key", {
  rows: { fields: {}, indexes: {} },
});

const Rows = () => schema.instance(INSTANCE).table("rows");

/**
 * An engine that cannot read the outer row inside a table function's argument fails the walk of
 * the map's array with an unknown table; one that reads the wrong row sums the wrong members.
 */
describe("a map over an array that reads the outer row by each element as a key", function () {
  this.timeout(60_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Rows().insert(DOCS).run();
  });

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  it("filters on the sum of the members the elements name", async () => {
    const rows = await Rows()
      .filter((row) =>
        row
          .key("list")
          .map((el) => row.key(el).cast<number>())
          .sum()
          .gt(3),
      )
      .run();
    expect(rows.map((row) => row._id).sort()).to.deep.equal([
      "missing",
      "over",
    ]);
  });
});
