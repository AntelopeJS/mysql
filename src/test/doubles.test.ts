import { expect } from "chai";
import { type RowDataPacket, createConnection } from "mysql2/promise";
import type { AtomicUpdate } from "@antelopejs/interface-database/atomic";
import { Schema } from "@antelopejs/interface-database/schema";
import type { Table } from "@antelopejs/interface-database/selection";

import { GetOptions } from "../config";
import { PhysicalTable } from "./tables";
import { QUIET_MS, SettlesWithin } from "./watch";

/**
 * Doubles MySQL 8.4's JSON text parser reads as a neighbour or as another number: a 17-digit
 * double, a sum that is not its decimal, the least subnormal, the greatest double and a negative
 * zero, which JSON text spells `0`.
 */
const DOUBLES = [
  123456789.12345679,
  0.1 + 0.2,
  5e-324,
  1.7976931348623157e308,
  -0,
];
const LONG = DOUBLES[0];

/** The doubles a dedup answers, which reads a negative zero as the 0 that `eq` finds equal to it. */
const DEDUPED = DOUBLES.map((value) => (value === 0 ? 0 : value));

/** A container of doubles, as each JSON column and undeclared object holds one. */
interface Numbers {
  list: number[];
  long: number;
  zero?: number;
}

interface Doc {
  _id: string;
  label?: string;
  revision?: string;
  n?: number;
  nums?: number[];
  meta?: Numbers;
  loose?: number[];
  one?: number;
  zero?: number;
  nested?: Numbers;
  copied?: number[];
  mapped?: number[];
}

/** Every shape a double is written in: declared columns, the overflow, and containers inside both. */
const WRITTEN = {
  n: LONG,
  nums: DOUBLES,
  meta: { list: DOUBLES, long: LONG, zero: -0 },
  loose: DOUBLES,
  one: LONG,
  zero: -0,
  nested: { list: DOUBLES, long: LONG },
};

const schema = new Schema<{ rows: Doc }>("doubles", {
  rows: {
    fields: { label: "string", n: "number", nums: "number[]", meta: "object" },
    indexes: {},
  },
});

function Rows(): Table<Doc> {
  return schema.instance().table("rows");
}

/**
 * The row as the server prints it, its declared columns beside its undeclared keys, read by the
 * plain driver rather than by the adapter. The server prints each double it holds exactly.
 */
async function Printed(id: string): Promise<string> {
  const connection = await createConnection(GetOptions().url);
  try {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT CAST(JSON_MERGE_PRESERVE(COALESCE(_extra, JSON_OBJECT()), JSON_OBJECT('n', n, 'nums', nums, 'meta', meta)) AS CHAR) AS doc FROM \`${PhysicalTable("doubles", "rows")}\` WHERE _instance = '' AND _id = ?`,
      [id],
    );
    return String(rows[0]?.doc);
  } finally {
    await connection.end();
  }
}

describe("a double written into JSON", function () {
  this.timeout(30_000);

  beforeEach(async () => {
    await Rows().delete();
  });

  it("is stored exactly by an insert", async () => {
    await Rows().insert({ _id: "inserted", ...WRITTEN });
    expect(await Rows().get("inserted")).to.deep.include(WRITTEN);
    expect(JSON.parse(await Printed("inserted"))).to.deep.include(WRITTEN);
  });

  it("is stored exactly by an update", async () => {
    await Rows().insert({ _id: "updated" });
    expect(await Rows().get("updated").update(WRITTEN)).to.equal(1);
    expect(await Rows().get("updated")).to.deep.include(WRITTEN);
    expect(JSON.parse(await Printed("updated"))).to.deep.include(WRITTEN);
  });

  it("is stored exactly by a replace", async () => {
    await Rows().insert({ _id: "replaced", label: "before" });
    expect(await Rows().get("replaced").replace(WRITTEN)).to.equal(1);
    expect(await Rows().get("replaced")).to.deep.include(WRITTEN);
    expect(JSON.parse(await Printed("replaced"))).to.deep.include(WRITTEN);
  });

  for (const conflict of ["update", "replace"] as const) {
    it(`is stored exactly by an insert that merges into an existing row with conflict '${conflict}'`, async () => {
      await Rows().insert({ _id: conflict, label: "before" });
      await Rows().insert({ _id: conflict, ...WRITTEN }, { conflict });
      expect(await Rows().get(conflict)).to.deep.include(WRITTEN);
      expect(JSON.parse(await Printed(conflict))).to.deep.include(WRITTEN);
    });
  }

  it("is stored exactly by an update computed from the row", async () => {
    await Rows().insert({ _id: "mapped", loose: DOUBLES });
    const updated = await Rows()
      .get("mapped")
      .update((row) => ({
        ...WRITTEN,
        copied: row.key("loose"),
        mapped: row.key("loose").map((value) => value),
      }));
    expect(updated).to.equal(1);
    const computed = { ...WRITTEN, copied: DOUBLES, mapped: DOUBLES };
    expect(await Rows().get("mapped")).to.deep.include(computed);
    expect(JSON.parse(await Printed("mapped"))).to.deep.include(computed);
  });

  it("is stored exactly by an atomic update's patch", async () => {
    await Rows().insert({ _id: "atomic", revision: "old" });
    const update: AtomicUpdate<Doc> = {
      type: "update",
      revisionField: "revision",
      expectedRevision: "old",
      nextRevision: "new",
      patch: WRITTEN,
    };
    expect(await Rows().atomicMutation("atomic", update)).to.equal("applied");
    expect(await Rows().get("atomic")).to.deep.include(WRITTEN);
    expect(JSON.parse(await Printed("atomic"))).to.deep.include(WRITTEN);
  });

  it("is read exactly through an array walk, a group and an ordered nested query", async () => {
    await Rows().insert(
      DOUBLES.map((one, n) => ({
        _id: `r${n}`,
        label: "g",
        n,
        one,
        loose: DOUBLES,
      })),
    );
    const [walked] = await Rows()
      .orderBy("n")
      .map((row) => row.key("loose").map((value) => value));
    const [group] = await Rows().group("label", (stream) => ({
      all: stream.map((row) => row.key("one")),
      distinct: stream.distinct("one"),
    }));
    const [nested] = await Rows()
      .orderBy("n")
      .map(() => ({
        ones: Rows()
          .orderBy("n")
          .map((row) => row.key("one")),
      }));
    expect(walked).to.deep.equal(DOUBLES);
    expect(group?.all).to.have.deep.members(DOUBLES);
    expect(group?.distinct).to.have.deep.members(DEDUPED);
    expect(nested?.ones).to.deep.equal(DOUBLES);
  });

  it("is delivered exactly by a change feed", async () => {
    const feed = Rows().changes().cursor();
    try {
      const first = feed.next();
      for (let probe = 0; !(await SettlesWithin(first, QUIET_MS)); probe++) {
        await Rows().insert({ _id: `probe-${probe}` });
      }
      await Rows().insert({ _id: "watched", ...WRITTEN });
      let delivered: Doc | undefined;
      while (delivered?._id !== "watched") {
        const step = await feed.next();
        delivered = step.done
          ? expect.fail("the feed ended")
          : step.value.newValue;
      }
      expect(delivered).to.deep.include(WRITTEN);
    } finally {
      await feed.return?.();
    }
  });
});
