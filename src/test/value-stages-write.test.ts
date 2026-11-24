import assert from "node:assert/strict";

import { FIXTURE, type Fixture, ValueStageTable } from "./value-stage-table";

type DeepPartial<Value> = { [Key in keyof Value]?: Value[Key] };

const table = ValueStageTable("value-stages-write");

describe("An update through the value stages", function () {
  this.timeout(30_000);
  before(() => table.setup());
  after(() => table.teardown());

  it("stores what an array walk, an object merge, a split, a text and a date stage compute from the row it replaces", async () => {
    await table
      .rows()
      .update((doc) => ({
        nums: doc.key("nums").map((value) => value.mul(2)),
        tags: doc.key("tags").filter((tag) => tag.ne("a")),
        meta: doc.key("meta").merge({ a: 9 }),
        name: doc.key("name").upcase().concat("!"),
        bornAt: doc.key("bornAt").add(60),
      }))
      .run();
    const [row] = await table.rows().run();
    assert.deepEqual(row.nums, [6, 2, 4]);
    assert.deepEqual(row.tags, ["b", "c"]);
    assert.deepEqual(row.meta, { a: 9, b: { x: 1 }, empty: null });
    assert.equal(row.name, "ADA!");
    assert.deepEqual(row.bornAt, new Date(FIXTURE.bornAt.getTime() + 60_000));
  });

  it("writes a document holding stage func and an args pair as a document, not as a lambda", async () => {
    const lookalike = { stage: "func", args: [[1, 2], "x"] };
    // SAFETY: the fixture's types do not declare the two keys this document carries, which the table stores in its overflow column.
    await table
      .rows()
      .update(lookalike as DeepPartial<Fixture>)
      .run();
    const [row] = await table.rows().run();
    // SAFETY: the stored row carries the two overflow keys the update wrote.
    const stored = row as Fixture & typeof lookalike;
    assert.deepEqual({ stage: stored.stage, args: stored.args }, lookalike);
  });
});
