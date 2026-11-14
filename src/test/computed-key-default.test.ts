import { expect } from "chai";
import type { ValueProxy } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";

const INSTANCE = "one";
const ROWS = 200;
const DEPTH = 14;
/** How deep the document of the row a default answers on goes before a stored null. */
const SHALLOW = 5;
/**
 * Twenty times the chain's run time, about 25 ms, and a fifth of a chain evaluating each link's
 * value twice, 2^14 reads per row: 2.8 s on MySQL 8.4 and 29 s on MariaDB 11.8.
 */
const BUDGET_MS = 500;
/** MariaDB 11.8's deepest JSON value: a row whose member is nested one level less. */
const DEEPEST = 31;

interface Nested {
  [key: string]: Nested | string | null;
}

interface Doc {
  _id: string;
  nest: Nested;
  nestKey: string;
}

const schema = new Schema<{ docs: Doc }>("computed-key-default", {
  docs: { fields: {}, indexes: {} },
});

function NestOf(depth: number, leaf: string | null): Nested {
  return { k: depth === 1 ? leaf : NestOf(depth - 1, leaf) };
}

const Docs = () => schema.instance(INSTANCE).table("docs");

/** The document read `DEPTH` times by the key the row names, each read falling back to `{}`. */
function Chain() {
  return Docs()
    .orderBy("_id")
    .map((row) =>
      Array.from({ length: DEPTH }).reduce(
        (value: ValueProxy<Nested | string | null>) =>
          value
            .cast<Nested>()
            .key(row.key("nestKey"))
            .default({})
            .cast<Nested | string | null>(),
        row.key("nest").cast<Nested | string | null>(),
      ),
    );
}

describe("a chain of computed-key reads each followed by default()", function () {
  this.timeout(120_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Docs()
      .insert(
        Array.from({ length: ROWS }, (_, n) => ({
          _id: `d-${String(n).padStart(3, "0")}`,
          nest: n === 0 ? NestOf(SHALLOW, null) : NestOf(DEPTH, "w"),
          nestKey: "k",
        })),
      )
      .run();
  });

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  it("defaults a row as deep as MariaDB stores", async () => {
    const id = "d-deep";
    await Docs()
      .insert({ _id: id, nest: NestOf(DEEPEST - 1, "w"), nestKey: "k" })
      .run();
    try {
      const [read] = await Docs()
        .filter((row) => row.key("_id").eq(id))
        .map((row) => row.default({}).cast<Doc>().key("nestKey"))
        .run();
      expect(read).to.equal("k");
    } finally {
      await Docs().get(id).delete().run();
    }
  });

  it("reads each link's value once", async () => {
    const start = performance.now();
    const read = await Chain().run();
    const elapsed = performance.now() - start;
    expect(read).to.deep.equal([
      {},
      ...Array.from({ length: ROWS - 1 }, () => "w"),
    ]);
    expect(elapsed).to.be.below(BUDGET_MS);
  });
});
