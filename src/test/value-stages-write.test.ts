import assert from "node:assert/strict";

import { FIXTURE, ValueStageTable } from "./value-stage-table";

const table = ValueStageTable("value-stages-write");

describe("An update through the value stages", () => {
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
    const [row] = await table.rows();
    assert.deepEqual(row.nums, [6, 2, 4]);
    assert.deepEqual(row.tags, ["b", "c"]);
    assert.deepEqual(row.meta, { a: 9, b: { x: 1 }, empty: null });
    assert.equal(row.name, "ADA!");
    assert.deepEqual(row.bornAt, new Date(FIXTURE.bornAt.getTime() + 60_000));
  });
});
