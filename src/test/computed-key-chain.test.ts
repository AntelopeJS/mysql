import { expect } from "chai";
import type { ValueProxy } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";

const INSTANCE = "one";
const LEVELS = 8;

type Doc = Record<string, string | number> & { _id: string };

const HOPS = Array.from({ length: LEVELS + 1 }, (_, level) => `h${level}`);

const DOCS: Doc[] = [
  {
    _id: "chain",
    start: "h0",
    ...Object.fromEntries(
      HOPS.slice(0, -1).map((hop, at) => [hop, HOPS[at + 1]]),
    ),
  },
  { _id: "number", start: "h0", h0: 5 },
];

const schema = new Schema<{ rows: Doc }>("computed_key_chain", {
  rows: { fields: {}, indexes: {} },
});

const Rows = () => schema.instance(INSTANCE).table("rows");

/** The member named by the key `levels` hops down from `start`, each hop's key the hop before's value. */
function Hop(row: ValueProxy<Doc>, levels: number): ValueProxy<string> {
  let key = row.key("start").cast<string>();
  for (let level = 0; level < levels; level++) {
    key = row.key(key).cast<string>();
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
    expect(ends.number).to.deep.equal([
      "h0",
      5,
      ...Array.from({ length: LEVELS - 1 }, () => null),
    ]);
  });

  it("filters on the member the last hop names", async () => {
    const rows = await Rows()
      .filter((row) => Hop(row, LEVELS).eq(HOPS[LEVELS]))
      .run();
    expect(rows.map((row) => row._id)).to.deep.equal(["chain"]);
  });
});
