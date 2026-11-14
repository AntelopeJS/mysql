import { expect } from "chai";
import type { ValueProxy } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";

const INSTANCE = "one";
const ROWS = 200;
const DEPTH = 14;
/** How deep the document of the row a default answers on goes before a stored null. */
const SHALLOW = 5;
/**
 * Twenty times the chain's run time, and a tenth of a chain evaluating each link's value twice:
 * 6.4 s and 12.4 s on MariaDB 11.8 for the two spellings.
 */
const BUDGET_MS = 500;

interface Nested {
  [key: string]: Nested | string | null;
}

interface Doc {
  _id: string;
  nest: Nested;
}

type Link = ValueProxy<Nested | string | null>;

const schema = new Schema<{ docs: Doc }>("static-key-default", {
  docs: { fields: {}, indexes: {} },
});

function NestOf(depth: number, leaf: string | null): Nested {
  return { k: depth === 1 ? leaf : NestOf(depth - 1, leaf) };
}

const Docs = () => schema.instance(INSTANCE).table("docs");

/** The document read `DEPTH` times through `link`, in `_id` order. */
function Chain(link: (value: Link) => Link) {
  return Docs()
    .orderBy("_id")
    .map((row) =>
      Array.from({ length: DEPTH }).reduce(
        link,
        row.key("nest").cast<Nested | string | null>(),
      ),
    );
}

async function Timed(link: (value: Link) => Link) {
  const start = performance.now();
  const read = await Chain(link).run();
  return { read, elapsed: performance.now() - start };
}

const EXPECTED = [{}, ...Array.from({ length: ROWS - 1 }, () => "w")];

describe("a chain of static-key reads each with a default", function () {
  this.timeout(120_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Docs()
      .insert(
        Array.from({ length: ROWS }, (_, n) => ({
          _id: `d-${String(n).padStart(3, "0")}`,
          nest: n === 0 ? NestOf(SHALLOW, null) : NestOf(DEPTH, "w"),
        })),
      )
      .run();
  });

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  it("reads each link's value once through default()", async () => {
    const { read, elapsed } = await Timed((value) =>
      value.cast<Nested>().key("k").default({}).cast<Nested | string | null>(),
    );
    expect(read).to.deep.equal(EXPECTED);
    expect(elapsed).to.be.below(BUDGET_MS);
  });

  it("reads each link's value once through key(k, def)", async () => {
    const { read, elapsed } = await Timed((value) =>
      value.cast<Nested>().key("k", {}).cast<Nested | string | null>(),
    );
    expect(read).to.deep.equal(EXPECTED);
    expect(elapsed).to.be.below(BUDGET_MS);
  });
});
