import assert from "node:assert/strict";
import { ValueProxy } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";

const INSTANCE = "one";

const schema = new Schema("match-non-text", {
  cells: {
    fields: { label: "string", count: "number", flag: "boolean", at: "date" },
    indexes: {},
  },
});

const cells = () => schema.instance(INSTANCE).table("cells");

const DECLARED = { count: 42, flag: true, at: new Date(0) };

const OVERFLOW_CELLS = [
  { label: "string", value: "text" },
  { label: "number", value: 42 },
  { label: "boolean", value: true },
  { label: "null", value: null },
  { label: "array", value: ["text"] },
  { label: "object", value: { text: "text" } },
];

describe("match on a value that is not text", function () {
  this.timeout(30_000);
  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await cells()
      .insert(OVERFLOW_CELLS.map((cell) => ({ ...cell, ...DECLARED })))
      .run();
  });
  after(() => schema.destroyInstance(INSTANCE).run());

  it("answers false on a stored JSON cell that is not a string, rather than NULL", async () => {
    const rows = await cells()
      .map((row) => ({
        label: row.key("label"),
        matched: row.key("value").match("."),
      }))
      .run();
    assert.deepEqual(
      Object.fromEntries(rows.map((row) => [row.label, row.matched])),
      {
        string: true,
        number: false,
        boolean: false,
        null: false,
        array: false,
        object: false,
      },
    );
  });

  it("answers false on a declared number, boolean or date and on a constant number, rather than matching its text rendering", async () => {
    const [row] = await cells()
      .filter((cell) => cell.key("label").eq("string"))
      .map((cell) => ({
        count: cell.key("count").match("^4"),
        flag: cell.key("flag").match("^t"),
        at: cell.key("at").match("^1970"),
        constant: ValueProxy.constant<unknown>(42).match("^4"),
      }))
      .run();
    assert.deepEqual(row, {
      count: false,
      flag: false,
      at: false,
      constant: false,
    });
  });
});
