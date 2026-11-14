import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "outer_row_walked";
const INSTANCE = "one";
const OWNER = "big";
/**
 * Rows of one owner whose ids are long enough that an array of the rows, or of their ids alone,
 * outgrows 16 MiB, the `max_allowed_packet` MariaDB 11.8 and 12.3 start with, past which an
 * aggregate comes back cut.
 */
const ROWS = 34_000;
const ID_CHARS = 500;
const BATCH = 1000;

interface Entry {
  _id: string;
  owner: string;
  n: number;
}

interface Holder {
  _id: string;
}

const schema = new Schema<{ entries: Entry; holders: Holder }>(SCHEMA_ID, {
  entries: { fields: { owner: "string", n: "number" }, indexes: {} },
  holders: { fields: {}, indexes: {} },
});

function EntryAt(n: number): Entry {
  return { _id: String(n).padStart(ID_CHARS, "0"), owner: OWNER, n };
}

async function Seed(): Promise<void> {
  await schema.createInstance(INSTANCE).run();
  const entries = schema.instance(INSTANCE).table("entries");
  for (let at = 0; at < ROWS; at += BATCH) {
    const batch = Array.from({ length: Math.min(BATCH, ROWS - at) }, (_, n) =>
      EntryAt(at + n),
    );
    await entries.insert(batch).run();
  }
  await schema
    .instance(INSTANCE)
    .table("holders")
    .insert([{ _id: OWNER }])
    .run();
}

async function Unseed(): Promise<void> {
  await schema.destroyInstance(INSTANCE).run();
}

/**
 * A stage after a slice of the outer row's rows that read them back from one aggregate past the
 * engine's bound would read an array the engine cut short, and fail on its JSON text.
 */
async function CountsEveryRow(): Promise<void> {
  const read = await schema
    .instance(INSTANCE)
    .table("holders")
    .map((holder) =>
      schema
        .instance(INSTANCE)
        .table("entries")
        .filter((entry) => entry.key("owner").eq(holder.key("_id")))
        .slice(0, ROWS)
        .filter((entry) => entry.key("n").ge(0))
        .count(),
    )
    .run();
  expect(read).to.deep.equal([ROWS]);
}

describe("a stage after a slice of an outer row's rows that outgrow an aggregate", function () {
  this.timeout(300_000);

  before(Seed);

  after(Unseed);

  it("counts every row of the outer row", CountsEveryRow);
});
