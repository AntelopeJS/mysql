import { expect } from "chai";
import { ValueProxy } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";

const INSTANCE = "one";

interface Loose {
  _id: string;
  loose?: string | null;
}

const schema = new Schema<{ rows: Loose }>("null-string", {
  rows: { fields: {}, indexes: {} },
});

const ROWS: Loose[] = [
  { _id: "word", loose: "null" },
  { _id: "nil", loose: null },
  { _id: "absent" },
];

const Rows = () => schema.instance(INSTANCE).table("rows");

describe('a stored "null" string against a null over an undeclared field', function () {
  this.timeout(30_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Rows().insert(ROWS).run();
  });

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  it("eq(null) keeps only the null and the absent field", async () => {
    const read = await Rows()
      .filter((row) => row.key("loose").eq(null))
      .map((row) => row.key("_id"))
      .run();
    expect(read).to.have.members(["nil", "absent"]);
  });

  it('ne(null) keeps the "null" string', async () => {
    const read = await Rows()
      .filter((row) => row.key("loose").ne(null))
      .map((row) => row.key("_id"))
      .run();
    expect(read).to.have.members(["word"]);
  });

  it('adds the "null" string to an array', async () => {
    const read = await Rows()
      .filter((row) => row.key("_id").eq("word"))
      .map((row) =>
        ValueProxy.constant(["x"]).add(
          row.key<{ loose: string[] | null }>("loose"),
        ),
      )
      .run();
    expect(read).to.deep.equal([["x", "null"]]);
  });
});
