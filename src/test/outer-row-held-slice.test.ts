import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

import {
  MAX_INSTANCE_ID_CHARS,
  MAX_KEY_CHARS,
} from "../implementations/database/utils";

const SCHEMA_ID = "outer_row_held_slice";
const OWNER = "o";
const BATCH = 500;

/**
 * Identities as long as the module allows, of control characters only, which MariaDB's JSON
 * writes as six bytes each: the most room a held identity can take.
 */
const CONTROL = "\u0001";
const INSTANCE = CONTROL.repeat(MAX_INSTANCE_ID_CHARS);
const DIGITS = 31;
const DIGIT_CHARS = 3;

/** The most rows whose identities fit in 16 MiB at their largest, and a few rows past it. */
const HELD = 4358;
const ROWS = HELD + 3;

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

/** A distinct id of control characters, its last ones spelling `n` in base 31. */
function IdAt(n: number): string {
  const digits = Array.from({ length: DIGIT_CHARS }, (_, at) =>
    String.fromCharCode(1 + (Math.floor(n / DIGITS ** at) % DIGITS)),
  );
  return CONTROL.repeat(MAX_KEY_CHARS - DIGIT_CHARS) + digits.join("");
}

async function Seed(): Promise<void> {
  await schema.createInstance(INSTANCE).run();
  const entries = schema.instance(INSTANCE).table("entries");
  for (let at = 0; at < ROWS; at += BATCH) {
    const batch = Array.from(
      { length: Math.min(BATCH, ROWS - at) },
      (_, n) => ({
        _id: IdAt(at + n),
        owner: OWNER,
        n: at + n,
      }),
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
 * A slice of as many rows as it holds the identities of, and one just past them, each counted
 * after a stage: a bound that held more identities than fit in 16 MiB would read an array MariaDB
 * cut short, and fail on its JSON text.
 */
async function CountsEachSlice(): Promise<void> {
  for (const count of [HELD, ROWS]) {
    const read = await schema
      .instance(INSTANCE)
      .table("holders")
      .map((holder) =>
        schema
          .instance(INSTANCE)
          .table("entries")
          .filter((entry) => entry.key("owner").eq(holder.key("_id")))
          .slice(0, count)
          .filter((entry) => entry.key("n").ge(0))
          .count(),
      )
      .run();
    expect(read, String(count)).to.deep.equal([count]);
  }
}

describe("a stage after a slice of the largest identities an aggregate holds", function () {
  this.timeout(300_000);

  before(Seed);

  after(Unseed);

  it("counts each slice", CountsEachSlice);
});
