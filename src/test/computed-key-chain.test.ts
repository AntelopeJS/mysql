import { expect } from "chai";
import type { ValueProxy } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";

const INSTANCE = "one";
const LEVELS = 8;

type Doc = Record<string, string | boolean | { next: string }> & {
  _id: string;
};

const HOPS = Array.from({ length: LEVELS + 1 }, (_, level) => `h${level}`);

const DOCS: Doc[] = [
  {
    _id: "chain",
    start: "h0",
    ...Object.fromEntries(
      HOPS.slice(0, -1).map((hop, at) => [hop, HOPS[at + 1]]),
    ),
  },
  { _id: "boolean", start: "h0", h0: true, true: "h1", h1: "h2" },
  {
    _id: "member",
    start: "h0",
    ...Object.fromEntries(
      HOPS.slice(0, -1).map((hop, at) => [hop, { next: HOPS[at + 1] }]),
    ),
  },
  {
    _id: "upcase",
    start: "h0",
    ...Object.fromEntries(
      HOPS.slice(0, -1).map((hop, at) => [hop.toUpperCase(), HOPS[at + 1]]),
    ),
  },
];

type Step = (
  row: ValueProxy<Doc>,
  key: ValueProxy<string>,
) => ValueProxy<string>;

/** One hop of each chain, by the shape that sits between two computed reads. */
const STEPS = {
  chain: (row, key) => row.key(key).cast<string>(),
  member: (row, key) => row.key(key).cast<{ next: string }>().key("next"),
  upcase: (row, key) => row.key(key.upcase()).cast<string>(),
} satisfies Record<string, Step>;

const schema = new Schema<{ rows: Doc }>("computed_key_chain", {
  rows: { fields: {}, indexes: {} },
});

const Rows = () => schema.instance(INSTANCE).table("rows");

/** The member named by the key `levels` hops down from `start`, each hop's key the hop before's value. */
function Hop(
  row: ValueProxy<Doc>,
  levels: number,
  step: Step = STEPS.chain,
): ValueProxy<string> {
  let key = row.key("start").cast<string>();
  for (let level = 0; level < levels; level++) {
    key = step(row, key);
  }
  return key;
}

describe("a chain of keys each computed from the one before", function () {
  this.timeout(60_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Rows().insert(DOCS).run();
  });

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  it("reads the member each hop names, and NULL past a hop whose value is no string", async () => {
    const rows = await Rows()
      .map((row) => ({
        id: row.key("_id"),
        ends: Array.from({ length: LEVELS + 1 }, (_, levels) =>
          Hop(row, levels),
        ),
      }))
      .run();
    const ends = Object.fromEntries(rows.map((row) => [row.id, row.ends]));
    expect(ends.chain).to.deep.equal(HOPS);
    expect(ends.boolean).to.deep.equal([
      "h0",
      true,
      ...Array.from({ length: LEVELS - 1 }, () => null),
    ]);
  });

  it("filters on the member the last hop names", async () => {
    const rows = await Rows()
      .filter((row) => Hop(row, LEVELS).eq(HOPS[LEVELS]))
      .run();
    expect(rows.map((row) => row._id)).to.deep.equal(["chain"]);
  });

  for (const [id, step] of [
    ["member", STEPS.member],
    ["upcase", STEPS.upcase],
  ] as const) {
    it(`reads the member each hop names through ${id} hops`, async () => {
      const rows = await Rows()
        .filter((row) => row.key("_id").eq(id))
        .map((row) =>
          Array.from({ length: LEVELS + 1 }, (_, levels) =>
            Hop(row, levels, step),
          ),
        )
        .run();
      expect(rows).to.deep.equal([HOPS]);
    });
  }
});
