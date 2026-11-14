import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

const INSTANCE = "one";

interface Doc {
  _id: string;
  n: number;
}

const schema = new Schema<{ rows: Doc }>("merge_map_stages", {
  rows: { fields: {}, indexes: {} },
});

const Rows = () => schema.instance(INSTANCE).table("rows");

const Plucked = () => Rows().orderBy("_id").pluck("_id", "n");

const Sorted = (lists: readonly (readonly unknown[])[]) =>
  lists.map((list) => list.map(String).sort());

/**
 * An engine that cannot resolve a walk of a merged object, or of the row a merge reads, fails with
 * an unknown table or column, as MySQL 8.4 and 9.7 did before walks held their source and as MySQL
 * 8.4 did while the hold read a bare outer column; one that walks the wrong row answers its members.
 */
describe("a map stage that walks a merged object", function () {
  this.timeout(60_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Rows()
      .insert([
        { _id: "a", n: 1 },
        { _id: "b", n: 2 },
      ])
      .run();
  });

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  it("lists the keys of a merged object", async () => {
    const keys = await Plucked()
      .map((row) => row.merge({ m: "x" }).keys())
      .run();
    expect(Sorted(keys)).to.deep.equal([
      ["_id", "m", "n"],
      ["_id", "m", "n"],
    ]);
  });

  it("lists the values of a merged object", async () => {
    const values = await Plucked()
      .map((row) => row.merge({ m: "x" }).values())
      .run();
    expect(Sorted(values)).to.deep.equal([
      ["1", "a", "x"],
      ["2", "b", "x"],
    ]);
  });

  it("lists the keys of two merges chained in one stage", async () => {
    const keys = await Plucked()
      .map((row) => row.merge({ m: "x" }).merge({ o: "y" }).keys())
      .run();
    expect(Sorted(keys)).to.deep.equal([
      ["_id", "m", "n", "o"],
      ["_id", "m", "n", "o"],
    ]);
  });

  it("lists the keys of a merge over the merge of the stage before", async () => {
    const keys = await Plucked()
      .map((row) => row.merge({ 'a"b': "1", n: 0 }))
      .map((row) => row.merge({ n: 9, c: "3" }).keys())
      .run();
    expect(Sorted(keys)).to.deep.equal([
      ["_id", 'a"b', "c", "n"],
      ["_id", 'a"b', "c", "n"],
    ]);
  });

  it("merges the keys of the merge of the stage before into it", async () => {
    const rows = await Plucked()
      .map((row) => row.merge({ m: "x" }))
      .map((row) => row.merge({ k: row.keys() }))
      .run();
    expect(rows.map((row) => ({ ...row, k: [...row.k].sort() }))).to.deep.equal(
      [
        { _id: "a", n: 1, m: "x", k: ["_id", "m", "n"] },
        { _id: "b", n: 2, m: "x", k: ["_id", "m", "n"] },
      ],
    );
  });

  it("filters on the keys of a merged row", async () => {
    const ids = await Rows()
      .filter((row) => row.merge({ m: "x" }).keys().count().gt(2))
      .count()
      .run();
    expect(ids).to.equal(2);
  });
});
