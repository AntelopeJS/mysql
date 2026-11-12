import { expect } from "chai";
import { DuplicateKeyError } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";

import { Read } from "../connection";
import { type Sql, ident, sql } from "../statement";
import { WaitForIndexes } from "../implementations/database/schema";
import { Compiled } from "./compiled";
import { PhysicalTable, Run } from "./tables";

const SCHEMA_ID = "untyped_index";
const INSTANCE = "one";
const FILLER_ROWS = 600;

type Stored = string | number | boolean | null | { tag: string } | number[];

interface Row {
  _id: string;
  sku?: Stored;
  obj?: { n?: Stored };
  whole?: Stored;
}

const FIELDS = { obj: "object", whole: "any" } as const;

const schema = new Schema<{ bare: Row; keyed: Row; unique: Row }>(SCHEMA_ID, {
  bare: { fields: FIELDS, indexes: {} },
  keyed: {
    fields: FIELDS,
    indexes: { sku: {}, objN: { fields: ["obj.n"] }, whole: {} },
  },
  unique: { fields: FIELDS, indexes: { sku: { unique: true } } },
});

/** One row per kind of JSON value, in the order MySQL sorts JSON: absent, null, numbers, strings, object, array, false, true. */
const VALUES: readonly (readonly [string, Stored | undefined])[] = [
  ["absent", undefined],
  ["null", null],
  ["neg", -1.5],
  ["n5", 5],
  ["n9", 9],
  ["n10", 10],
  ["n100", 100],
  ["s10", "10"],
  ["s5", "5"],
  ["sA", "A"],
  ["sb", "b"],
  ["sTrue", "true"],
  ["obj", { tag: "x" }],
  ["arr", [2, 1]],
  ["f", false],
  ["t", true],
];

const NAMED = VALUES.map(([id]) => id);

/** Rows past the named ones, so the optimizer prefers an index to a scan; they sort after every named string. */
const FILLER: Row[] = Array.from({ length: FILLER_ROWS }, (_, n) => ({
  _id: `fill${n}`,
  sku: `zz${String(n).padStart(4, "0")}`,
  obj: { n: `zz${n}` },
  whole: `zz${n}`,
}));

function RowOf(id: string, value: Stored | undefined): Row {
  if (value === undefined) {
    return { _id: id, obj: {} };
  }
  return { _id: id, sku: value, obj: { n: value }, whole: value };
}

const ROWS = [...VALUES.map(([id, value]) => RowOf(id, value)), ...FILLER];

type TableId = "bare" | "keyed";

function Table(table: TableId) {
  return schema.instance(INSTANCE).table(table);
}

/** The name a query gives each indexed part: the index on the keyed table, the field or path on the bare one. */
const PARTS = [
  { index: "sku", field: "sku" },
  { index: "objN", field: "obj.n" },
  { index: "whole", field: "whole" },
] as const;

function NameOn(table: TableId, part: (typeof PARTS)[number]): string {
  return table === "keyed" ? part.index : part.field;
}

function Ids(rows: readonly Row[]): string[] {
  return rows.map((row) => row._id).sort();
}

function Named(ids: readonly string[]): string[] {
  return ids.filter((id) => NAMED.includes(id));
}

async function SortedIds(
  table: TableId,
  part: (typeof PARTS)[number],
  direction: "asc" | "desc",
): Promise<string[]> {
  const rows = await Table(table).orderBy(NameOn(table, part), direction).run();
  return Named(rows.map((row) => row._id));
}

/** The index MySQL picks for a read, as `EXPLAIN` names it. */
async function IndexUsed(statement: Sql): Promise<string> {
  const [plan] = await Read(sql`EXPLAIN FORMAT=TRADITIONAL ${statement}`);
  return String(plan.get("key"));
}

describe("an index over a value of no declared type", function () {
  this.timeout(120_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Table("bare").insert(ROWS).run();
    await Table("keyed").insert(ROWS).run();
    await WaitForIndexes(SCHEMA_ID);
    await Run(sql`ANALYZE TABLE ${ident(PhysicalTable(SCHEMA_ID, "keyed"))}`);
  });

  for (const key of [5, "5", 10, "10", true, false, -1.5, "A"] as const) {
    it(`finds by getAll(${JSON.stringify(key)}) the rows holding that very value, with or without the index`, async () => {
      const expected = VALUES.filter(([, value]) => value === key).map(
        ([id]) => id,
      );
      for (const part of PARTS) {
        for (const table of ["bare", "keyed"] as const) {
          const rows = await Table(table)
            .getAll(key, NameOn(table, part))
            .run();
          expect(Ids(rows), `${table} ${part.field}`).to.deep.equal(expected);
        }
      }
    });
  }

  it("finds a list of keys of mixed types by value", async () => {
    for (const part of PARTS) {
      const rows = await Table("keyed")
        .getAll([9, "5", true], part.index)
        .run();
      expect(Ids(rows), part.field).to.deep.equal(["n9", "s5", "t"]);
    }
  });

  it("ranges over the numbers between two numbers, and the strings between two strings", async () => {
    for (const table of ["bare", "keyed"] as const) {
      const numbers = await Table(table).between("sku", 4, 50).run();
      expect(Ids(numbers), table).to.deep.equal(["n10", "n5", "n9"]);
      const strings = await Table(table).between("sku", "1", "B").run();
      expect(Ids(strings), table).to.deep.equal(["s10", "s5", "sA"]);
    }
  });

  it("ranges between bounds of two types as the unindexed read does", async () => {
    for (const [low, high] of [
      [9, "B"],
      [false, true],
      ["5", false],
      [-2, 0],
    ] as const) {
      const bare = await Table("bare").between("sku", low, high).run();
      const keyed = await Table("keyed").between("sku", low, high).run();
      expect(Ids(keyed), `${low}..${high}`).to.deep.equal(Ids(bare));
    }
  });

  it("sorts every kind of value in MySQL's JSON order, numbers by value, with or without the index", async () => {
    const present = NAMED.filter((id) => id !== "absent" && id !== "null");
    for (const direction of ["asc", "desc"] as const) {
      const expected = direction === "asc" ? NAMED : [...NAMED].reverse();
      for (const part of PARTS) {
        const keyed = await SortedIds("keyed", part, direction);
        const bare = await SortedIds("bare", part, direction);
        const declaredNull = part.field === "whole";
        const wanted = declaredNull
          ? expected.filter((id) => present.includes(id))
          : expected;
        const kept = (ids: string[]) =>
          declaredNull ? ids.filter((id) => present.includes(id)) : ids;
        expect(kept(keyed), `keyed ${part.field} ${direction}`).to.deep.equal(
          wanted,
        );
        expect(kept(bare), `bare ${part.field} ${direction}`).to.deep.equal(
          wanted,
        );
      }
    }
  });

  it("groups each value apart, numbers by value, with or without the index", async () => {
    for (const part of PARTS) {
      const groups = await Promise.all(
        (["bare", "keyed"] as const).map(async (table) => {
          const rows = await Table(table)
            .group(NameOn(table, part), (stream, value) => ({
              value,
              count: stream.count(),
            }))
            .run();
          return rows
            .map((row) => `${JSON.stringify(row.value)}=${row.count}`)
            .sort();
        }),
      );
      expect(groups[1], part.field).to.deep.equal(groups[0]);
      expect(groups[1], part.field).to.include.members(["9=1", "10=1"]);
    }
  });

  it("compares through the index as the unindexed read does", async () => {
    const queries = [
      (table: TableId) => Table(table).filter((row) => row.key("sku").gt(6)),
      (table: TableId) => Table(table).filter((row) => row.key("sku").eq("A")),
      (table: TableId) =>
        Table(table).filter((row) => row.key("sku").default("zz").eq("zz")),
      (table: TableId) =>
        Table(table).filter((row) => row.key("obj").key("n").le(9)),
    ];
    for (const query of queries) {
      const bare = Ids(await query("bare").run());
      expect(Ids(await query("keyed").run())).to.deep.equal(bare);
    }
  });

  it("still looks a string up, ranges over strings and sorts through the index", async () => {
    const keyed = Table("keyed");
    const reads = [
      keyed.getAll("sA", "sku"),
      keyed.between("sku", "zz0001", "zz0003"),
      keyed.filter((row) => row.key("sku").eq("zz0007")),
      keyed.orderBy("sku").slice(0, 20),
    ];
    for (const read of reads) {
      expect(await IndexUsed(Compiled(read))).to.equal("sku");
    }
  });
});

describe("a unique index over a value of no declared type", function () {
  this.timeout(60_000);

  function Unique() {
    return schema.instance(INSTANCE).table("unique");
  }

  before(async () => {
    await Unique()
      .insert([
        { _id: "n7", sku: 7 },
        { _id: "s7", sku: "7" },
        { _id: "t", sku: true },
        { _id: "null", sku: null },
        { _id: "absent" },
      ])
      .run();
    await WaitForIndexes(SCHEMA_ID);
  });

  for (const [id, sku] of [
    ["n7again", 7],
    ["s7again", "7"],
    ["tAgain", true],
  ] as const) {
    it(`refuses a second row holding ${JSON.stringify(sku)}`, async () => {
      const failure = await Unique()
        .insert({ _id: id, sku })
        .run()
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      expect(failure).to.be.instanceOf(DuplicateKeyError);
    });
  }

  it("takes a second null and a second absent value, which hold no key", async () => {
    await Unique()
      .insert([{ _id: "null2", sku: null }, { _id: "absent2" }])
      .run();
    expect(Ids(await Unique().run())).to.include.members(["null2", "absent2"]);
  });
});
