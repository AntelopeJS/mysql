import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

const INSTANCE = "one";
const FALLBACK = "fallback";

interface Note {
  _id: string;
  typed?: string | null;
  loose?: string | null;
}

const schema = new Schema<{ notes: Note }>("default-distinct", {
  notes: { fields: { typed: "string" }, indexes: {} },
});

const ROWS: Note[] = [
  { _id: "word", typed: "null", loose: "null" },
  { _id: "text", typed: "a", loose: "a" },
  { _id: "nil", typed: null, loose: null },
  { _id: "absent" },
];

const EXPECTED = ["null", "a", FALLBACK];

const Notes = () => schema.instance(INSTANCE).table("notes");

describe("default() before distinct()", function () {
  this.timeout(30_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Notes().insert(ROWS).run();
  });

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  for (const field of ["typed", "loose"] as const) {
    it(`keeps a stored "null" string in a ${field} field`, async () => {
      const read = await Notes()
        .map((note) => note.key(field).default(FALLBACK))
        .distinct()
        .run();
      expect(read).to.have.members(EXPECTED);
    });

    it(`keeps a stored "null" string in a ${field} field of a nested query`, async () => {
      const [read] = await Notes()
        .filter((note) => note.key("_id").eq("word"))
        .map(() =>
          Notes()
            .map((note) => note.key(field).default(FALLBACK))
            .distinct(),
        )
        .run();
      expect(read).to.have.members(EXPECTED);
    });
  }
});
