import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "outer_row_held";
const INSTANCE = "one";
const OWNER = "big";
/**
 * Rows of one owner whose ids are long enough that the array of their keys outgrows 16 MiB, the
 * `max_allowed_packet` MariaDB 11.8 and 12.3 start with, past which an aggregate comes back cut.
 */
const ROWS = 34_000;
const ID_CHARS = 500;
const KEYS = ["a", "b"];
const BATCH = 1000;

interface Entry {
  _id: string;
  owner: string;
  key: string;
}

interface Holder {
  _id: string;
}

const schema = new Schema<{ entries: Entry; holders: Holder }>(SCHEMA_ID, {
  entries: { fields: { owner: "string", key: "string" }, indexes: {} },
  holders: { fields: {}, indexes: {} },
});

function EntryAt(n: number): Entry {
  return {
    _id: String(n).padStart(ID_CHARS, "0"),
    owner: OWNER,
    key: KEYS[n % KEYS.length],
  };
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
 * A group that held its outer row's rows in one aggregate past the engine's bound would read an
 * array the engine cut short, and answer no group at all.
 */
async function GroupsEveryRow(): Promise<void> {
  const read = await schema
    .instance(INSTANCE)
    .table("holders")
    .map((holder) => ({
      id: holder.key("_id"),
      groups: schema
        .instance(INSTANCE)
        .table("entries")
        .filter((entry) => entry.key("owner").eq(holder.key("_id")))
        .group("key", (stream, key) => ({ key, count: stream.count() })),
    }))
    .run();
  expect(
    read.map((row) => ({
      id: row.id,
      groups: [...row.groups].sort((left, right) =>
        left.key.localeCompare(right.key),
      ),
    })),
  ).to.deep.equal([
    {
      id: OWNER,
      groups: KEYS.map((key) => ({ key, count: ROWS / KEYS.length })),
    },
  ]);
}

describe("a nested group of an outer row whose rows outgrow an aggregate", function () {
  this.timeout(300_000);

  before(Seed);

  after(Unseed);

  it("groups every row of the outer row", GroupsEveryRow);
});
