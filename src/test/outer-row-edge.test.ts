import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";
import type { ValueProxyOrValue } from "@antelopejs/interface-database";

const SCHEMA_ID = "outer_row_edge";
const INSTANCE = "one";
const OWNER = "o";

interface Entry {
  _id: string;
  owner: string;
  rank?: number;
  name: string;
}

interface Holder {
  _id: string;
}

const schema = new Schema<{ entries: Entry; holders: Holder }>(SCHEMA_ID, {
  entries: {
    fields: { owner: "string", rank: "number", name: "string" },
    indexes: {},
  },
  holders: { fields: {}, indexes: {} },
});

/** More rows than a slice holds the identities of, so a long slice is bounded by its edge rows. */
const ROWS = 5000;

/**
 * Ranks with ties, and rows without one, which sort first ascending and last descending. Most
 * ranks are tied, so no order of the rows decides which tied rows a slice keeps.
 */
const RANKS = Array.from({ length: ROWS }, (_, n) =>
  n % 7 === 0 ? undefined : (n * 37) % 50,
);

/**
 * Slices across ties and absent ranks, from the first row, inside the rows, and past them: short
 * ones, whose rows' identities are held, and long ones, bounded by their edge rows.
 */
const SLICES: readonly (readonly [number, number])[] = [
  [0, 3],
  [1, 3],
  [2, 40],
  [4998, 10],
  [5000, 2],
  [0, 0],
  [0, 4400],
  [1, 4500],
  [300, 4400],
  [450, 10000],
];

const DIRECTIONS = ["asc", "desc"] as const;

/**
 * Names that share their first thousand characters, more than MariaDB sorts a text by where the
 * sort takes a `LIMIT`, so it sorts them as equal there.
 */
const SHARED = "x".repeat(1000);

function Entries() {
  return schema.instance(INSTANCE).table("entries");
}

async function Seed(): Promise<void> {
  await schema.createInstance(INSTANCE).run();
  await Entries()
    .insert(
      RANKS.map((rank, n) => {
        const name = `${SHARED}${String(ROWS - n).padStart(4, "0")}`;
        return rank === undefined
          ? { _id: `e${n}`, owner: OWNER, name }
          : { _id: `e${n}`, owner: OWNER, rank, name };
      }),
    )
    .run();
  await schema
    .instance(INSTANCE)
    .table("holders")
    .insert([{ _id: OWNER }])
    .run();
}

async function Unseed(): Promise<void> {
  await schema.destroyInstance(INSTANCE).run();
}

function Sorted(ranks: readonly unknown[]): string[] {
  return ranks.map((rank) => JSON.stringify(rank ?? null)).sort();
}

/**
 * A stage after an ordered slice of the outer row's rows keeps the ranks the same slice keeps at
 * the top, where no outer row is read: a slice whose edges compared ties, or absent ranks, out of
 * the order the engine sorts them in would keep other ranks, or more or fewer rows.
 */
async function KeepsTheSlicedRanks(): Promise<void> {
  for (const direction of DIRECTIONS) {
    for (const [offset, count] of SLICES) {
      const top = await Entries()
        .orderBy("rank", direction)
        .slice(offset, count)
        .map((entry) => entry.key("rank"))
        .run();
      const [nested] = await schema
        .instance(INSTANCE)
        .table("holders")
        .map((holder) =>
          Entries()
            .filter((entry) => entry.key("owner").eq(holder.key("_id")))
            .orderBy("rank", direction)
            .slice(offset, count)
            .filter((entry) => entry.key("owner").eq(holder.key("_id")))
            .map((entry) => entry.key("rank")),
        )
        .run();
      expect(Sorted(nested), `${direction} ${offset} ${count}`).to.deep.equal(
        Sorted(top),
      );
    }
  }
}

/**
 * A stage after a slice sorted by long text keeps as many rows as the same slice keeps at the top:
 * edges read by a sort that compares only the names' leading characters, and rows compared with
 * them by their whole names, would keep fewer.
 */
async function CountsALongTextSlice(): Promise<void> {
  for (const [offset, count] of SLICES) {
    const sliced = (owner: ValueProxyOrValue<string>) =>
      Entries()
        .filter((entry) => entry.key("owner").eq(owner))
        .orderBy("name")
        .slice(offset, count)
        .filter((entry) => entry.key("owner").eq(owner))
        .count();
    const top = await sliced(OWNER).run();
    const nested = await schema
      .instance(INSTANCE)
      .table("holders")
      .map((holder) => sliced(holder.key("_id")))
      .run();
    expect(nested, `${offset} ${count}`).to.deep.equal([top]);
  }
}

describe("a stage after an ordered slice of an outer row's rows", function () {
  this.timeout(300_000);

  before(Seed);

  after(Unseed);

  it("keeps the ranks the slice keeps", KeepsTheSlicedRanks);

  it("counts a slice sorted by long text", CountsALongTextSlice);
});
