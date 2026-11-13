import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "outer_row_keyed";
const INSTANCES = ["one", "two"];
/** `o1` holds 1,024 rows of distinct keys and one without a key: past 1,024 × 1,024 = 2^20. */
const KEYED_ROWS = 1024;
/** `plumless` and `buckeroo` share a CRC-32, quoted or not, so a hash alone would merge them. */
const COLLIDING_KEYS = ["plumless", "buckeroo"];
/** `o2` holds 3 rows of each of 64 keys `o1` also holds. */
const SHARED_KEYS = 64;
const SHARED_REPEATS = 3;
/** Rows of `o1` with a negative `n`, under keys it also holds, which the filter drops. */
const DROPPED_ROWS = 10;
const BATCH = 500;

interface Entry {
  _id: string;
  owner: string;
  key?: string;
  n: number;
}

interface Holder {
  _id: string;
}

const schema = new Schema<{ entries: Entry; holders: Holder }>(SCHEMA_ID, {
  entries: {
    fields: { owner: "string", key: "string", n: "number" },
    indexes: {},
  },
  holders: { fields: {}, indexes: {} },
});

function KeyOf(n: number): string {
  return n < COLLIDING_KEYS.length ? COLLIDING_KEYS[n] : `k${n}`;
}

const ENTRIES: Entry[] = [
  ...Array.from({ length: KEYED_ROWS }, (_, n) => ({
    _id: `a${n}`,
    owner: "o1",
    key: KeyOf(n),
    n,
  })),
  { _id: "a-keyless", owner: "o1", n: KEYED_ROWS },
  ...Array.from({ length: DROPPED_ROWS }, (_, n) => ({
    _id: `d${n}`,
    owner: "o1",
    key: KeyOf(n),
    n: -1 - n,
  })),
  ...Array.from({ length: SHARED_KEYS * SHARED_REPEATS }, (_, n) => ({
    _id: `b${n}`,
    owner: "o2",
    key: KeyOf(n % SHARED_KEYS),
    n: Math.floor(n / SHARED_KEYS),
  })),
];

const HOLDERS: Holder[] = [{ _id: "o1" }, { _id: "o2" }];

interface KeyGroup {
  key: string | null;
  count: number;
  total: number;
}

function Grouped(owner: string): KeyGroup[] {
  const groups = new Map<string | null, KeyGroup>();
  for (const entry of ENTRIES) {
    if (entry.owner !== owner || entry.n < 0) {
      continue;
    }
    const key = entry.key ?? null;
    const group = groups.get(key) ?? { key, count: 0, total: 0 };
    groups.set(key, {
      key,
      count: group.count + 1,
      total: group.total + entry.n,
    });
  }
  return SortedByKey([...groups.values()]);
}

function SortedByKey<T extends { key?: string | null }>(
  groups: readonly T[],
): T[] {
  return [...groups].sort((left, right) =>
    String(left.key).localeCompare(String(right.key)),
  );
}

async function Seed(): Promise<void> {
  for (const instance of INSTANCES) {
    await schema.createInstance(instance).run();
    const entries = schema.instance(instance).table("entries");
    for (let at = 0; at < ENTRIES.length; at += BATCH) {
      await entries.insert(ENTRIES.slice(at, at + BATCH)).run();
    }
    await schema.instance(instance).table("holders").insert(HOLDERS).run();
  }
}

async function Unseed(): Promise<void> {
  for (const instance of INSTANCES) {
    await schema.destroyInstance(instance).run();
  }
}

/**
 * Every instance holds the same rows, and `o2` holds keys `o1` holds too, so a group that read
 * another instance's rows, another owner's, or the rows the filter drops would count them.
 */
async function GroupsManyKeys(): Promise<void> {
  const [instance] = INSTANCES;
  const read = await schema
    .instance(instance)
    .table("holders")
    .map((holder) => ({
      id: holder.key("_id"),
      groups: schema
        .instance(instance)
        .table("entries")
        .filter((entry) => entry.key("n").ge(0))
        .filter((entry) => entry.key("owner").eq(holder.key("_id")))
        .group("key", (stream, key) => ({
          key,
          count: stream.count(),
          total: stream.sum("n"),
        })),
    }))
    .run();
  expect(
    read.map((row) => ({ id: row.id, groups: SortedByKey(row.groups) })),
  ).to.have.deep.members(
    HOLDERS.map((holder) => ({ id: holder._id, groups: Grouped(holder._id) })),
  );
}

describe("a nested group of many keys that reads its outer row", function () {
  this.timeout(120_000);

  before(Seed);

  after(Unseed);

  it("groups only the rows of its own instance and outer row", GroupsManyKeys);
});
