import assert from "node:assert/strict";
import { ValueProxy } from "@antelopejs/interface-database";

import { First, ValueStageTable } from "./value-stage-table";

const table = ValueStageTable("value-stages-container");

const LIST = ["a", "b", "c", "d", "e"];

const SLICES: readonly (readonly [number, number | undefined])[] = [
  [0, 2],
  [1, 3],
  [2, undefined],
  [-2, undefined],
  [1, -1],
  [-3, -1],
  [-9, 2],
  [0, 99],
  [3, 1],
];

describe("The array stages", () => {
  before(() => table.setup());
  after(() => table.teardown());

  it("slice with bounds that count from the end when negative, as Array.prototype.slice does", async () => {
    for (const [start, end] of SLICES) {
      assert.deepEqual(
        await First(
          table.rows().map(() => ValueProxy.constant(LIST).slice(start, end)),
        ),
        LIST.slice(start, end),
        `slice(${start}, ${end})`,
      );
    }
  });

  it("index from the start, from the end when negative, and answer NULL beyond either end", async () => {
    assert.deepEqual(
      await First(
        table.rows().map(() => ({
          first: ValueProxy.constant(LIST).index(0),
          last: ValueProxy.constant(LIST).index(-1),
          secondLast: ValueProxy.constant(LIST).index(-2),
          truncated: ValueProxy.constant(LIST).index(1.9),
          past: ValueProxy.constant(LIST).index(5),
          before: ValueProxy.constant(LIST).index(-6),
          huge: ValueProxy.constant(LIST).index(1e300),
        })),
      ),
      {
        first: "a",
        last: "e",
        secondLast: "d",
        truncated: "b",
        past: null,
        before: null,
        huge: null,
      },
    );
  });

  it("measure an array and answer NULL for a value that is not one", async () => {
    assert.deepEqual(
      await First(
        table.rows().map((row) => ({
          count: row.key("nums").count(),
          empty: ValueProxy.constant<string[]>([]).isempty(),
          notEmpty: row.key("nums").isempty(),
          scalar: row.key("name").cast<string[]>().count(),
          object: row.key("meta").cast<string[]>().isempty(),
        })),
      ),
      { count: 3, empty: true, notEmpty: false, scalar: null, object: null },
    );
  });

  it("reduce an array, with the sum of none 0 and the rest of none NULL", async () => {
    assert.deepEqual(
      await First(
        table.rows().map((row) => ({
          sum: row.key("nums").sum(),
          avg: row.key("nums").avg(),
          min: row.key("nums").min(),
          max: row.key("tags").max(),
          emptySum: ValueProxy.constant<number[]>([]).sum(),
          emptyAvg: ValueProxy.constant<number[]>([]).avg(),
          emptyMin: ValueProxy.constant<number[]>([]).min(),
        })),
      ),
      {
        sum: 6,
        avg: 2,
        min: 1,
        max: "c",
        emptySum: 0,
        emptyAvg: null,
        emptyMin: null,
      },
    );
  });
});

describe("The array stages that read each element", () => {
  before(() => table.setup());
  after(() => table.teardown());

  it("map and filter in the array's own order, keeping a null a callback answers", async () => {
    assert.deepEqual(
      await First(
        table.rows().map((row) => ({
          mapped: row.key("tags").map((tag) => tag.upcase()),
          doubled: row.key("nums").map((value) => value.mul(2)),
          filtered: row.key("nums").filter((value) => value.gt(1)),
          nested: row
            .key("nums")
            .map((value) =>
              ValueProxy.constant([1, 2]).map((one) => one.add(value)),
            ),
          kept: ValueProxy.constant([0, 1, 2, 3]).filter((value) =>
            value.mod(2).eq(1),
          ),
        })),
      ),
      {
        mapped: ["B", "A", "C"],
        doubled: [6, 2, 4],
        filtered: [3, 2],
        nested: [
          [4, 5],
          [2, 3],
          [3, 4],
        ],
        kept: [1, 3],
      },
    );
  });

  it("tell a number from the text that spells it when it looks for an element", async () => {
    assert.deepEqual(
      await First(
        table.rows().map((row) => ({
          number: row.key("nums").includes(1),
          absent: row.key("nums").includes(9),
          text: row.key("tags").includes("a"),
        })),
      ),
      { number: true, absent: false, text: true },
    );
  });

  it("concatenate two lists in order, and answer NULL for a null operand", async () => {
    assert.deepEqual(
      await First(
        table.rows().map((row) => ({
          both: row.key("tags").add(row.key("tags")),
          nulled: row.key("tags").add(null),
        })),
      ),
      { both: ["b", "a", "c", "b", "a", "c"], nulled: null },
    );
  });
});

describe("The object stages", () => {
  before(() => table.setup());
  after(() => table.teardown());

  it("merge one level deep with the right's members winning and a null kept", async () => {
    assert.deepEqual(
      await First(
        table
          .rows()
          .map((row) => row.key("meta").merge({ b: null, c: [1], a: 2 })),
      ),
      { a: 2, b: null, c: [1], empty: null },
    );
  });

  it("keep merging a chain of merges, each operand of the next held once", async () => {
    assert.deepEqual(
      await First(
        table
          .rows()
          .map((row) =>
            row
              .key("meta")
              .merge({ a: 2 })
              .merge({ d: 4 })
              .merge({ e: 5 })
              .merge({ f: 6 }),
          ),
      ),
      { a: 2, b: { x: 1 }, empty: null, d: 4, e: 5, f: 6 },
    );
  });

  it("answer NULL when a side of a merge is not an object", async () => {
    assert.equal(
      await First(
        table
          .rows()
          .map((row) => row.key("name").cast<{ a: number }>().merge({ a: 1 })),
      ),
      null,
    );
  });

  it("list the keys and the values of an object in one order, and nothing for an empty one", async () => {
    const document = { b: 1, a: null, ccc: [1], é: "x" };
    const walked = await First(
      table.rows().map(() => ({
        keys: ValueProxy.constant(document).keys(),
        values: ValueProxy.constant(document).values(),
        none: ValueProxy.constant({}).keys(),
      })),
    );
    assert.ok(walked);
    const byKey = (left: [string, unknown], right: [string, unknown]) =>
      left[0].localeCompare(right[0]);
    assert.deepEqual(
      walked.keys
        .map((key, at): [string, unknown] => [key, walked.values[at]])
        .sort(byKey),
      Object.entries(document).sort(byKey),
    );
    assert.deepEqual(walked.none, []);
  });

  it("test for fields: a null value is present, a non-object has none, and an empty list is an object test", async () => {
    assert.deepEqual(
      await First(
        table.rows().map((row) => ({
          present: row.key("meta").hasfields("a", "b"),
          nullValued: row.key("meta").hasfields("empty"),
          missing: row.key("meta").hasfields("a", "zzz"),
          array: row.key("tags").cast<{ a: number }>().hasfields("a"),
          none: row.key("meta").hasfields(),
          noneOfArray: row.key("tags").cast<{ a: number }>().hasfields(),
        })),
      ),
      {
        present: true,
        nullValued: true,
        missing: false,
        array: false,
        none: true,
        noneOfArray: false,
      },
    );
  });
});
