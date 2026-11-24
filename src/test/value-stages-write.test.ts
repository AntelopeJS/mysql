import assert from "node:assert/strict";
import { Schema } from "@antelopejs/interface-database/schema";

import { FIXTURE, ValueStageTable } from "./value-stage-table";

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
});

interface Lookalike {
  _id: string;
  stage: string;
  args: unknown[];
}

const lookalikeSchema = new Schema<{ rows: Lookalike }>(
  "value-stages-write-lookalike",
  {
    rows: { fields: { stage: "string", args: "object" }, indexes: {} },
  },
);

describe("An update by a document", function () {
  this.timeout(30_000);
  const rows = () => lookalikeSchema.instance("one").table("rows");
  before(async () => {
    await lookalikeSchema.createInstance("one").run();
    await rows().insert({ _id: "row", stage: "", args: [] }).run();
  });
  after(() => lookalikeSchema.destroyInstance("one").run());

  it("writes a document holding stage func and an args pair as a document, not as a lambda", async () => {
    await rows()
      .update({ stage: "func", args: [[1, 2], "x"] })
      .run();
    const [row] = await rows().run();
    assert.equal(row.stage, "func");
    assert.deepEqual(row.args, [[1, 2], "x"]);
  });
});
