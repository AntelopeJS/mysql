import { expect } from "chai";
import type { Datum, ValueProxy } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "outer_row_walked_stages";
const INSTANCE = "one";
const OWNER = "big";
/**
 * Rows of one owner whose ids are long enough that an array of the rows outgrows 16 MiB, the
 * `max_allowed_packet` MariaDB 11.8 and 12.3 start with, past which an aggregate comes back cut.
 */
const ROWS = 34_000;
const ID_CHARS = 500;
const BATCH = 1000;

interface Entry {
  _id: string;
  owner: string;
  n: number;
  t: string;
}

interface Holder {
  _id: string;
}

const schema = new Schema<{ entries: Entry; holders: Holder }>(SCHEMA_ID, {
  entries: {
    fields: { owner: "string", n: "number", t: "string" },
    indexes: {},
  },
  holders: { fields: {}, indexes: {} },
});

function EntryAt(n: number): Entry {
  const _id = String(n).padStart(ID_CHARS, "0");
  return { _id, owner: OWNER, n, t: _id };
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

function OwnRows(holder: ValueProxy<Holder>) {
  return schema
    .instance(INSTANCE)
    .table("entries")
    .filter((entry) => entry.key("owner").eq(holder.key("_id")));
}

/** What a nested count answered: the whole count, an error naming the packet, or anything else. */
async function Answer(
  nested: (holder: ValueProxy<Holder>) => Datum<number>,
  rows: number,
): Promise<string> {
  try {
    const read = await schema
      .instance(INSTANCE)
      .table("holders")
      .map((holder) => nested(holder))
      .run();
    return read.length === 1 && read[0] === rows
      ? "whole"
      : `short ${read.join()}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /max_allowed_packet/.test(message) ? "packet" : message;
  }
}

/**
 * A stage over an outer row's rows read back from one aggregate cut at the engine's bound would
 * read an array cut short: a JSON_TABLE error or a short count, where it answers whole or names
 * the packet.
 */
const ANSWERED = ["whole", "packet"];

describe("a stage after an outer row's rows that outgrow an aggregate", function () {
  this.timeout(600_000);

  before(Seed);

  after(Unseed);

  it("counts every row after a map", async () => {
    expect(
      await Answer(
        (holder) =>
          OwnRows(holder)
            .map((entry) => ({ _id: entry.key("_id"), n: entry.key("n") }))
            .filter((entry) => entry.key("n").ge(0))
            .count(),
        ROWS,
      ),
    ).to.be.oneOf(ANSWERED);
  });

  it("counts every row after a pluck", async () => {
    expect(
      await Answer(
        (holder) =>
          OwnRows(holder)
            .pluck("_id", "n")
            .filter((entry) => entry.key("n").ge(0))
            .count(),
        ROWS,
      ),
    ).to.be.oneOf(ANSWERED);
  });

  it("counts every value after a distinct", async () => {
    expect(
      await Answer(
        (holder) =>
          OwnRows(holder)
            .distinct("t")
            .filter((t) => t.ne(""))
            .count(),
        ROWS,
      ),
    ).to.be.oneOf(ANSWERED);
  });

  it("counts every row after a union", async () => {
    expect(
      await Answer(
        (holder) =>
          OwnRows(holder)
            .union(OwnRows(holder))
            .filter((entry) => entry.key("n").ge(0))
            .count(),
        2 * ROWS,
      ),
    ).to.be.oneOf(ANSWERED);
  });

  it("counts every row after a slice the statement bounds", async () => {
    expect(
      await Answer(
        (holder) =>
          OwnRows(holder)
            .slice(0, schema.instance(INSTANCE).table("entries").count())
            .filter((entry) => entry.key("n").ge(0))
            .count(),
        ROWS,
      ),
    ).to.be.oneOf(ANSWERED);
  });

  it("counts every row after a long slice ordered by text", async () => {
    expect(
      await Answer(
        (holder) =>
          OwnRows(holder)
            .orderBy("t")
            .slice(0, ROWS)
            .filter((entry) => entry.key("n").ge(0))
            .count(),
        ROWS,
      ),
    ).to.be.oneOf(ANSWERED);
  });
});
