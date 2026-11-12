import { expect } from "chai";
import {
  AllBySlug,
  BySlug,
  ByText,
  CountsByKind,
  INSTANCE,
  type Item,
  KindsViewed,
  NOTED_VIEWS,
  OWNERS,
  Owners,
  Items,
  Seed,
  SortedByKind,
  Unseed,
  Viewed,
} from "./outer-row-fixture";

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

interface GroupsRead<T> {
  id: string;
  groups: T[];
}

/** Each owner's groups, which come in no order, as `expected` computes them for its `take`. */
function ExpectGroups<T extends { kind: string | null }>(
  read: GroupsRead<T>[],
  expected: (take: number) => T[],
): void {
  const sorted = read.map((row) => ({
    id: row.id,
    groups: SortedByKind(row.groups),
  }));
  expect(sorted).to.have.deep.members(
    OWNERS.map((owner) => ({ id: owner._id, groups: expected(owner.take) })),
  );
}

async function GroupAfterSlice(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      groups: Items()
        .filter((item) => item.key("views").eq(owner.key("take")))
        .orderBy("slug", "desc")
        .slice(0, 2)
        .group("kind", (stream, kind) => ({ kind, count: stream.count() })),
    }))
    .run();
  ExpectGroups(read, (take) =>
    CountsByKind(BySlug(Viewed(take)).reverse().slice(0, 2)),
  );
}

async function GroupAfterMap(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      groups: Items()
        .filter((item) => item.key("views").eq(owner.key("take")))
        .map((item) => ({ sort: item.key("kind") }))
        .group("sort", (stream, sort) => ({
          kind: sort,
          count: stream.count(),
        })),
    }))
    .run();
  ExpectGroups(read, (take) => CountsByKind(Viewed(take)));
}

/** Every owner's `take` is its own, so an item of that many views looks up the owner itself. */
async function GroupAfterLookup(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      groups: Items()
        .filter((item) => item.key("views").eq(owner.key("take")))
        .lookup(Owners(), "views", "take")
        .group("kind", (stream, kind) => ({
          kind,
          owners: stream.map((item) => item.key("views").key("_id")).distinct(),
        })),
    }))
    .run();
  const owner = (take: number) => OWNERS.find((one) => one.take === take);
  ExpectGroups(read, (take) =>
    KindsViewed(take).map((kind) => ({ kind, owners: [owner(take)?._id] })),
  );
}

async function GroupAfterDistinct(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      groups: Items()
        .filter((item) => item.key("views").eq(owner.key("take")))
        .map((item) => ({ pair: { kind: item.key("kind") } }))
        .distinct("pair")
        .group("kind", (stream, kind) => ({ kind, count: stream.count() })),
    }))
    .run();
  ExpectGroups(read, (take) =>
    KindsViewed(take).map((kind) => ({ kind, count: 1 })),
  );
}

/** Part of an item, as a reshaped nested query answers it. */
type Row = Partial<Item> & { _instance?: string };

interface RowsGroup {
  kind: string | null;
  rows: Row[];
}

/** A document as the engine builds it, with no member for a field that holds no value. */
function Valued(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== null),
  );
}

/** A group's rows, which come in no order, by `_id`; rows without one are alike. */
function RowsById(groups: RowsGroup[]): RowsGroup[] {
  return groups.map((group) => ({
    kind: group.kind,
    rows: [...group.rows].sort((left, right) =>
      String(left._id).localeCompare(String(right._id)),
    ),
  }));
}

async function GroupAfterPluck(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      groups: Items()
        .filter((item) => item.key("views").eq(owner.key("take")))
        .pluck("kind")
        .group("kind", (stream, kind) => ({ kind, rows: stream })),
    }))
    .run();
  ExpectGroups(
    read.map((row) => ({ id: row.id, groups: RowsById(row.groups) })),
    (take) =>
      CountsByKind(Viewed(take)).map(({ kind, count }) => ({
        kind,
        rows: Array.from({ length: count }, () => Valued({ kind })),
      })),
  );
}

async function GroupAfterWithout(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      groups: Items()
        .filter((item) => item.key("views").eq(owner.key("take")))
        .without("slug")
        .group("kind", (stream, kind) => ({ kind, rows: stream })),
    }))
    .run();
  ExpectGroups(
    read.map((row) => ({ id: row.id, groups: RowsById(row.groups) })),
    (take) =>
      RowsById(
        KindsViewed(take).map((kind) => ({
          kind,
          rows: Viewed(take)
            .filter((item) => item.kind === kind)
            .map(({ slug: _slug, ...item }) =>
              Valued({ ...item, _instance: INSTANCE }),
            ),
        })),
      ),
  );
}

/** Both sides read the outer row; `o3` takes more views than any item has, so it reads them all. */
async function GroupAfterUnion(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      groups: Items()
        .filter((item) => item.key("views").eq(owner.key("take")))
        .union(
          Items().filter((item) => item.key("views").lt(owner.key("take"))),
        )
        .group("kind", (stream, kind) => ({ kind, count: stream.count() })),
    }))
    .run();
  ExpectGroups(read, (take) =>
    CountsByKind(AllBySlug().filter((item) => item.views <= take)),
  );
}

interface KindViews {
  kind: string;
  views: number;
}

/** A compound key's fields as one text, which a read is sorted by to compare. */
function KindViewsText(key: KindViews): string {
  return `${key.kind}/${key.views}`;
}

/** `kindViews` indexes two fields, so a group by its name groups by a document of both. */
async function GroupByIndexAfterSlice(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      groups: Items()
        .filter((item) => item.key("views").lt(owner.key("take")))
        .orderBy("slug")
        .slice(0, 6)
        .group("kindViews", (stream, key) => ({
          key: key.cast<KindViews>(),
          count: stream.count(),
        })),
    }))
    .run();
  const sorted = (groups: { key: KindViews; count: number }[]) =>
    [...groups].sort((left, right) =>
      KindViewsText(left.key).localeCompare(KindViewsText(right.key)),
    );
  expect(
    read.map((row) => ({ id: row.id, groups: sorted(row.groups) })),
  ).to.have.deep.members(
    OWNERS.map((owner) => {
      const counts = new Map<string, { key: KindViews; count: number }>();
      for (const item of AllBySlug()
        .filter((one) => one.views < owner.take)
        .slice(0, 6)) {
        const key = { kind: String(item.kind), views: item.views };
        const group = counts.get(KindViewsText(key)) ?? { key, count: 0 };
        counts.set(KindViewsText(key), { key, count: group.count + 1 });
      }
      return { id: owner._id, groups: sorted([...counts.values()]) };
    }),
  );
}

/** Only the second side reads the outer row; the first reads the items of no view. */
async function UnionReadingOuterRow(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      slugs: Items()
        .filter((item) => item.key("views").eq(0))
        .map((item) => item.key("slug"))
        .union(
          Items()
            .filter((item) => item.key("views").eq(owner.key("take")))
            .map((item) => item.key("slug")),
        ),
    }))
    .run();
  expect(
    read.map((row) => ({ id: row.id, slugs: [...row.slugs].sort() })),
  ).to.have.deep.members(
    OWNERS.map((owner) => ({
      id: owner._id,
      slugs: [...Viewed(0), ...Viewed(owner.take)]
        .map((item) => item.slug)
        .sort(),
    })),
  );
}

describe("nested queries that read their outer row", function () {
  this.timeout(30_000);

  before(Seed);

  after(Unseed);

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
  it("groups the rows a constant slice keeps", GroupAfterSlice);
  it("groups by a field a map computes", GroupAfterMap);
  it("groups rows whose key a lookup replaced", GroupAfterLookup);
  it("groups the rows a dedup keeps", GroupAfterDistinct);
  it("groups the documents a pluck builds", GroupAfterPluck);
  it("groups the documents a without leaves", GroupAfterWithout);
  it("groups a union of two queries", GroupAfterUnion);
  it("groups by an index of two fields after a slice", GroupByIndexAfterSlice);
  it(
    "concatenates a query with one that reads the outer row",
    UnionReadingOuterRow,
  );
});
