import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "outer_row";
const INSTANCE = "one";
const ITEMS = 24;
const VIEW_KINDS = 4;
const KIND_COUNT = 3;
/** Items of 1 view are 1, 5, 9…; every other one writes its tag with its keys reversed. */
const TAG_ORDERS = 8;
const NOTED_ITEM = 2;
const NOTED_VIEWS = NOTED_ITEM % VIEW_KINDS;

interface Item {
  _id: string;
  slug: string;
  kind: string | null;
  views: number;
  tag?: Record<string, number>;
  note?: null;
}

interface Owner {
  _id: string;
  take: number;
}

const schema = new Schema<{ items: Item; owners: Owner }>(SCHEMA_ID, {
  items: {
    fields: { slug: "string", kind: "string", views: "number" },
    indexes: {},
  },
  owners: { fields: { take: "number" }, indexes: {} },
});

function Items() {
  return schema.instance(INSTANCE).table("items");
}

function Owners() {
  return schema.instance(INSTANCE).table("owners");
}

const KINDS = ["a", "b", "c"];

/**
 * Item `n` has `n % 4` views and kind `a`, `b` or `c` by `n % 3`, so each view count meets every
 * kind; one more item of 3 views has no kind, which a dedup and a group keep as a value of its own.
 * An item of 1 view has an undeclared `tag`, one document written with its keys in either order.
 * Item 2 alone holds an undeclared `note`, a JSON null, which every other item of 2 views lacks.
 */
const ITEM_ROWS: Item[] = [
  ...Array.from({ length: ITEMS }, (_, n) => {
    const item: Item = {
      _id: `i${n}`,
      slug: `slug-${String(n).padStart(2, "0")}`,
      kind: KINDS[n % KIND_COUNT],
      views: n % VIEW_KINDS,
    };
    if (item.views === 1) {
      item.tag = n % TAG_ORDERS === 1 ? { x: 1, y: 2 } : { y: 2, x: 1 };
    }
    if (n === NOTED_ITEM) {
      item.note = null;
    }
    return item;
  }),
  { _id: "unkinded", slug: "slug-99", kind: null, views: 3 },
];

/** `o3` takes a view count no item has, so every nested query of it reads no row. */
const OWNERS: Owner[] = [
  { _id: "o1", take: 2 },
  { _id: "o2", take: 0 },
  { _id: "o3", take: 9 },
  { _id: "o4", take: 3 },
  { _id: "o5", take: 1 },
];

function Viewed(take: number): Item[] {
  return ITEM_ROWS.filter((item) => item.views === take);
}

/** Orders kinds by their text, a missing kind as `null`, which a result is sorted by to compare. */
function ByText(left: string | null, right: string | null): number {
  return String(left).localeCompare(String(right));
}

function KindsViewed(take: number): (string | null)[] {
  return [...new Set(Viewed(take).map((item) => item.kind))].sort(ByText);
}

async function Seed(): Promise<void> {
  await schema.createInstance(INSTANCE).run();
  await Items().insert(ITEM_ROWS).run();
  await Owners().insert(OWNERS).run();
}

interface KindsRead {
  id: string;
  kinds: (string | null)[];
}

function Sorted(read: KindsRead[]): KindsRead[] {
  return read.map((row) => ({
    id: row.id,
    kinds: [...row.kinds].sort(ByText),
  }));
}

const EXPECTED_KINDS = OWNERS.map((owner) => ({
  id: owner._id,
  kinds: KindsViewed(owner.take),
}));

async function OrderedThenFilteredDistinct(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      kinds: Items()
        .orderBy("slug")
        .filter((item) => item.key("views").eq(owner.key("take")))
        .map((item) => item.key("kind"))
        .distinct(),
    }))
    .run();
  expect(Sorted(read)).to.have.deep.members(EXPECTED_KINDS);
}

async function FieldDistinctAfterOrder(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      kinds: Items()
        .filter((item) => item.key("views").eq(owner.key("take")))
        .orderBy("slug")
        .distinct("kind"),
    }))
    .run();
  expect(Sorted(read)).to.have.deep.members(EXPECTED_KINDS);
}

async function CountOfDistinct(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      count: Items()
        .filter((item) => item.key("views").eq(owner.key("take")))
        .distinct("kind")
        .count(),
    }))
    .run();
  expect(read).to.have.deep.members(
    OWNERS.map((owner) => ({
      id: owner._id,
      count: KindsViewed(owner.take).length,
    })),
  );
}

async function DistinctSlicedByOuterRow(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      kinds: Items()
        .filter((item) => item.key("views").eq(owner.key("take")))
        .distinct("kind")
        .slice(0, owner.key("take")),
    }))
    .run();
  expect(read.map((row) => row.id)).to.have.members(
    OWNERS.map((owner) => owner._id),
  );
  for (const row of read) {
    const take = OWNERS.find((owner) => owner._id === row.id)?.take ?? 0;
    const kinds = KindsViewed(take);
    expect(row.kinds).to.have.lengthOf(Math.min(take, kinds.length));
    expect(new Set(row.kinds).size).to.equal(row.kinds.length);
    expect(kinds).to.include.members(row.kinds);
  }
}

/** A nested dedup keeps an absent `note` and a JSON null apart, as a dedup at the top does. */
async function DistinctKeepsAbsentApartFromNull(): Promise<void> {
  const top = await Items()
    .filter((item) => item.key("views").eq(NOTED_VIEWS))
    .distinct("note")
    .run();
  const [read] = await Owners()
    .filter((owner) => owner.key("take").eq(NOTED_VIEWS))
    .map((owner) => ({
      notes: Items()
        .filter((item) => item.key("views").eq(owner.key("take")))
        .distinct("note"),
      sliced: Items()
        .filter((item) => item.key("views").eq(owner.key("take")))
        .distinct("note")
        .slice(0, owner.key("take")),
    }))
    .run();
  expect(top).to.deep.equal([null, null]);
  expect(read.notes).to.have.deep.members(top);
  expect(read.sliced).to.have.deep.members(top);
}

async function GroupFilteredByOuterRow(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      groups: Items()
        .filter((item) => item.key("views").eq(owner.key("take")))
        .orderBy("slug")
        .group("kind", (stream, kind) => ({ kind, count: stream.count() })),
    }))
    .run();
  const sorted = read.map((row) => ({
    id: row.id,
    groups: [...row.groups].sort((left, right) =>
      ByText(left.kind, right.kind),
    ),
  }));
  expect(sorted).to.have.deep.members(
    OWNERS.map((owner) => ({
      id: owner._id,
      groups: KindsViewed(owner.take).map((kind) => ({
        kind,
        count: Viewed(owner.take).filter((item) => item.kind === kind).length,
      })),
    })),
  );
}

/**
 * MySQL takes the two key orders as one document and MariaDB, which keeps the text as written, as
 * two; a nested group keeps the documents a dedup of the same rows keeps, whichever the engine.
 */
async function GroupByDocumentOfOuterRow(): Promise<void> {
  const [read] = await Owners()
    .filter((owner) => owner.key("take").eq(1))
    .map((owner) => ({
      groups: Items()
        .filter((item) => item.key("views").eq(owner.key("take")))
        .group("tag", (stream, tag) => ({ tag, count: stream.count() })),
      tags: Items()
        .filter((item) => item.key("views").eq(owner.key("take")))
        .distinct("tag"),
    }))
    .run();
  expect(read.groups.map((group) => group.tag)).to.have.deep.members(read.tags);
  const counted = read.groups.reduce((sum, group) => sum + group.count, 0);
  expect(counted).to.equal(Viewed(1).length);
}

async function RowsSlicedByOuterRow(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      rows: Items()
        .filter((item) => item.key("views").eq(owner.key("take")))
        .orderBy("slug")
        .slice(1, owner.key("take")),
    }))
    .run();
  expect(read).to.have.deep.members(
    OWNERS.map((owner) => ({
      id: owner._id,
      rows: Viewed(owner.take)
        .sort((left, right) => left.slug.localeCompare(right.slug))
        .slice(1, 1 + owner.take)
        .map((item) => ({ ...item, _instance: INSTANCE })),
    })),
  );
}

describe("nested queries that read their outer row", function () {
  this.timeout(30_000);

  before(Seed);

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  it(
    "dedups a query ordered ahead of the filter that reads the outer row",
    OrderedThenFilteredDistinct,
  );
  it(
    "dedups a field of an ordered query that reads the outer row",
    FieldDistinctAfterOrder,
  );
  it(
    "counts the distinct values of a query that reads the outer row",
    CountOfDistinct,
  );
  it("slices a dedup by a count the outer row holds", DistinctSlicedByOuterRow);
  it(
    "keeps an absent field apart from a JSON null in a dedup that reads the outer row",
    DistinctKeepsAbsentApartFromNull,
  );
  it(
    "slices the rows it selects by a count the outer row holds",
    RowsSlicedByOuterRow,
  );
  it(
    "groups the rows a query that reads the outer row selects and orders",
    GroupFilteredByOuterRow,
  );
  it(
    "groups by a document as a dedup of the same rows compares it, whatever order its keys were written in",
    GroupByDocumentOfOuterRow,
  );
});
