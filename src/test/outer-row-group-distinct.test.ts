import { expect } from "chai";
import {
  AllBySlug,
  ByText,
  type Item,
  OWNERS,
  Owners,
  Items,
  Seed,
  Unseed,
} from "./outer-row-fixture";

type Entry = unknown[];

interface KindRead {
  kind: string | null;
  owners: Entry[][];
}

function ByNumber(left: number, right: number): number {
  return left - right;
}

function ByJson(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

/** Each owner's entries in their JSON order, and the owners in theirs. */
function Ordered(owners: Entry[][]): Entry[][] {
  return owners.map((each) => [...each].sort(ByJson)).sort(ByJson);
}

function Kinds(): (string | null)[] {
  return [...new Set(AllBySlug().map((item) => item.kind))].sort(ByText);
}

/** Per kind, what `entries` answers for the kind's items and each owner's `take`. */
function PerKind(
  entries: (items: Item[], take: number) => Entry[],
): KindRead[] {
  return Kinds().map((kind) => {
    const items = AllBySlug().filter((item) => item.kind === kind);
    return {
      kind,
      owners: Ordered(OWNERS.map((owner) => entries(items, owner.take))),
    };
  });
}

function Sorted(read: KindRead[]): KindRead[] {
  return read
    .map((group) => ({ kind: group.kind, owners: Ordered(group.owners) }))
    .sort((left, right) => ByText(left.kind, right.kind));
}

/** Each item's slug once per view count of its kind, so no two kinds answer the same entries. */
function DistinctEntries(items: Item[], take: number): Entry[] {
  return [...new Set(items.map((item) => item.views))].map((views) => [
    items[0].kind,
    views,
    take,
  ]);
}

function CollectedEntries(items: Item[], take: number): Entry[] {
  return items.map((item) => [item.slug, take]);
}

/** A group's stream deduplicated inside a query nested in the mapper, by values reading its row. */
async function DistinctReadingNestedRow(): Promise<void> {
  const read = await Items()
    .group("kind", (stream, kind) => ({
      kind,
      owners: Owners().map((owner) =>
        stream
          .map((item) => [
            item.key("kind"),
            item.key("views"),
            owner.key("take"),
          ])
          .distinct(),
      ),
    }))
    .run();
  expect(Sorted(read)).to.deep.equal(PerKind(DistinctEntries));
}

/** A group's stream collected inside a query nested in the mapper, by values reading its row. */
async function CollectReadingNestedRow(): Promise<void> {
  const read = await Items()
    .group("kind", (stream, kind) => ({
      kind,
      owners: Owners().map((owner) =>
        stream.map((item) => [item.key("slug"), owner.key("take")]),
      ),
    }))
    .run();
  expect(Sorted(read)).to.deep.equal(PerKind(CollectedEntries));
}

/** The items as a projection, which the group reads through a derived table. */
function Projected() {
  return Items().map((item) => ({
    kind: item.key("kind"),
    views: item.key("views"),
    slug: item.key("slug"),
  }));
}

/** {@link DistinctReadingNestedRow} over a projection of the items. */
async function DistinctOverProjection(): Promise<void> {
  const read = await Projected()
    .group("kind", (stream, kind) => ({
      kind,
      owners: Owners().map((owner) =>
        stream
          .map((item) => [
            item.key("kind"),
            item.key("views"),
            owner.key("take"),
          ])
          .distinct(),
      ),
    }))
    .run();
  expect(Sorted(read)).to.deep.equal(PerKind(DistinctEntries));
}

/** {@link CollectReadingNestedRow} over a projection of the items. */
async function CollectOverProjection(): Promise<void> {
  const read = await Projected()
    .group("kind", (stream, kind) => ({
      kind,
      owners: Owners().map((owner) =>
        stream.map((item) => [item.key("slug"), owner.key("take")]),
      ),
    }))
    .run();
  expect(Sorted(read)).to.deep.equal(PerKind(CollectedEntries));
}

/**
 * Per kind and view count with items, the sum each owner's `take` adds to every item's views. A key
 * document leaves out a kind that is `null`.
 */
function SumsPerKindViews() {
  return Kinds().flatMap((kind) =>
    [0, 1, 2, 3].flatMap((views) => {
      const count = AllBySlug().filter(
        (item) => item.kind === kind && item.views === views,
      ).length;
      const sums = OWNERS.map((owner) => count * (views + owner.take));
      return count === 0
        ? []
        : [
            {
              key: kind === null ? { views } : { kind, views },
              sums: sums.sort(ByNumber),
            },
          ];
    }),
  );
}

/** A compound key's group summed inside a query nested in the mapper, by values reading its row. */
async function SumReadingNestedRow(): Promise<void> {
  const read = await Items()
    .group("kindViews", (stream, key) => ({
      key,
      sums: Owners().map((owner) =>
        stream.map((item) => item.key("views").add(owner.key("take"))).sum(),
      ),
    }))
    .run();
  expect(
    read.map((group) => ({
      key: group.key,
      sums: [...group.sums].sort(ByNumber),
    })),
  ).to.have.deep.members(SumsPerKindViews());
}

/** Per kind, how many items it has, and the sums each owner's `take` adds to every item's views. */
function SumsPerKind() {
  return Kinds().map((kind) => {
    const items = AllBySlug().filter((item) => item.kind === kind);
    const views = items.reduce((total, item) => total + item.views, 0);
    return {
      kind,
      count: items.length,
      sums: OWNERS.map((owner) => views + items.length * owner.take).sort(
        ByNumber,
      ),
    };
  });
}

/**
 * A projection's group counted in the group's select, and summed inside a query nested in the
 * mapper by values reading its row.
 */
async function SumOverProjection(): Promise<void> {
  const read = await Projected()
    .group("kind", (stream, kind) => ({
      kind,
      count: stream.count(),
      sums: Owners().map((owner) =>
        stream.map((item) => item.key("views").add(owner.key("take"))).sum(),
      ),
    }))
    .run();
  expect(
    read
      .map((group) => ({
        kind: group.kind,
        count: group.count,
        sums: [...group.sums].sort(ByNumber),
      }))
      .sort((left, right) => ByText(left.kind, right.kind)),
  ).to.deep.equal(SumsPerKind());
}

describe("a group's stream inside a query nested in the mapper, by values reading its row", function () {
  this.timeout(30_000);

  before(Seed);

  after(Unseed);

  it("keeps one value per distinct value", DistinctReadingNestedRow);
  it("collects every value", CollectReadingNestedRow);
  it("sums the values of a compound key's group", SumReadingNestedRow);
  it(
    "keeps one value per distinct value over a projection",
    DistinctOverProjection,
  );
  it("collects every value over a projection", CollectOverProjection);
  it("sums the values over a projection", SumOverProjection);
});
