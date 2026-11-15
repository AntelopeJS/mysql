import { expect } from "chai";
import type { Datum, Stream, ValueProxy } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";

import { HandedOver, InBatchesOfOne } from "./batches";

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

/** Holders on either side of the one that owns rows, each owning none. */
const LINED = ["a", OWNER, "c"];

const schema = new Schema<{
  entries: Entry;
  holders: Holder;
  lined: Holder;
}>(SCHEMA_ID, {
  entries: {
    fields: { owner: "string", n: "number", t: "string" },
    indexes: {},
  },
  holders: { fields: {}, indexes: {} },
  lined: { fields: {}, indexes: {} },
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
  await schema
    .instance(INSTANCE)
    .table("lined")
    .insert(LINED.map((_id) => ({ _id })))
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

/** Reads every row of a query, through `run()` or a cursor. */
type Reader = <T>(query: Stream<T>) => Promise<T[]>;

async function Iterated<T>(query: Stream<T>): Promise<T[]> {
  const read: T[] = [];
  for await (const value of query) {
    read.push(value);
  }
  return read;
}

const READERS: ReadonlyArray<readonly [string, Reader]> = [
  ["", (query) => query.run()],
  [" through a cursor", Iterated],
];

/** What a nested count answered: the whole count, an error naming the packet, or anything else. */
async function Answer(
  read: Reader,
  nested: (holder: ValueProxy<Holder>) => Datum<number>,
  rows: number,
): Promise<string> {
  try {
    const answer = await read(
      schema
        .instance(INSTANCE)
        .table("holders")
        .map((holder) => nested(holder)),
    );
    return answer.length === 1 && answer[0] === rows
      ? "whole"
      : `short ${answer.join()}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /max_allowed_packet/.test(message) ? "packet" : message;
  }
}

/** How a cursor ended: whole, with an error naming the packet, or anything else. */
function Ending(failure: Error | undefined, isWhole: boolean): string {
  if (failure === undefined) {
    return isWhole ? "whole" : "short";
  }
  return /max_allowed_packet/.test(failure.message)
    ? "packet"
    : failure.message;
}

/**
 * A stage over an outer row's rows read back from one aggregate cut at the engine's bound would
 * read an array cut short: a JSON_TABLE error or a short count, where it answers whole or names
 * the packet.
 */
const ANSWERED = ["whole", "packet"];

const WALKS: ReadonlyArray<
  readonly [string, number, (holder: ValueProxy<Holder>) => Datum<number>]
> = [
  [
    "counts every row after a map",
    ROWS,
    (holder) =>
      OwnRows(holder)
        .map((entry) => ({ _id: entry.key("_id"), n: entry.key("n") }))
        .filter((entry) => entry.key("n").ge(0))
        .count(),
  ],
  [
    "counts every row after a pluck",
    ROWS,
    (holder) =>
      OwnRows(holder)
        .pluck("_id", "n")
        .filter((entry) => entry.key("n").ge(0))
        .count(),
  ],
  [
    "counts every value after a distinct",
    ROWS,
    (holder) =>
      OwnRows(holder)
        .distinct("t")
        .filter((t) => t.ne(""))
        .count(),
  ],
  [
    "counts every row after a union",
    2 * ROWS,
    (holder) =>
      OwnRows(holder)
        .union(OwnRows(holder))
        .filter((entry) => entry.key("n").ge(0))
        .count(),
  ],
  [
    "counts every row after a slice the statement bounds",
    ROWS,
    (holder) =>
      OwnRows(holder)
        .slice(0, schema.instance(INSTANCE).table("entries").count())
        .filter((entry) => entry.key("n").ge(0))
        .count(),
  ],
  [
    "counts every row after a long slice ordered by text",
    ROWS,
    (holder) =>
      OwnRows(holder)
        .orderBy("t")
        .slice(0, ROWS)
        .filter((entry) => entry.key("n").ge(0))
        .count(),
  ],
];

describe("a stage after an outer row's rows that outgrow an aggregate", function () {
  this.timeout(600_000);

  before(Seed);

  after(Unseed);

  for (const [through, read] of READERS) {
    for (const [name, rows, nested] of WALKS) {
      it(`${name}${through}`, async () => {
        expect(await Answer(read, nested, rows)).to.be.oneOf(ANSWERED);
      });
    }
  }

  describe("through a cursor of batches of one over outer rows around the one that owns them", function () {
    InBatchesOfOne();

    /**
     * A cursor that lists the warnings only at its end hands the count read from the cut aggregate
     * over before it fails, where every count it hands over is whole.
     */
    for (const [name, rows, nested] of WALKS) {
      it(`${name}, handing over only whole counts`, async () => {
        const { rows: handed, failure } = await HandedOver(
          schema
            .instance(INSTANCE)
            .table("lined")
            .orderBy("_id")
            .map((holder) => nested(holder)),
        );
        const counts = LINED.map((_id) => (_id === OWNER ? rows : 0));
        expect(handed).to.deep.equal(counts.slice(0, handed.length));
        expect(Ending(failure, handed.length === LINED.length)).to.be.oneOf(
          ANSWERED,
        );
      });
    }
  });
});
