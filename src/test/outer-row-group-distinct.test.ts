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

type Pair = number[];

function ByNumber(left: number, right: number): number {
  return left - right;
}

function ByPair(left: Pair, right: Pair): number {
  return left[0] - right[0] || left[1] - right[1];
}

/** One owner's pairs per array, the arrays in the order of their owner's `take`. */
function ByTake(pairs: Pair[][]): Pair[][] {
  return pairs
    .map((each) => [...each].sort(ByPair))
    .sort((left, right) => left[0][1] - right[0][1]);
}

function Kinds(): (string | null)[] {
  return [...new Set(AllBySlug().map((item) => item.kind))].sort(ByText);
}

/** Per kind, what `pairs` answers for the kind's items and each owner, as `ByTake` orders them. */
function PerKind(pairs: (items: Item[], take: number) => Pair[]) {
  return Kinds().map((kind) => {
    const items = AllBySlug().filter((item) => item.kind === kind);
    return {
      kind,
      owners: ByTake(OWNERS.map((owner) => pairs(items, owner.take))),
    };
  });
}

function Sorted(read: { kind: string | null; owners: Pair[][] }[]) {
  return read
    .map((group) => ({ kind: group.kind, owners: ByTake(group.owners) }))
    .sort((left, right) => ByText(left.kind, right.kind));
}

/** A group's stream deduplicated inside a query nested in the mapper, by values reading its row. */
async function DistinctReadingNestedRow(): Promise<void> {
  const read = await Items()
    .group("kind", (stream, kind) => ({
      kind,
      owners: Owners().map((owner) =>
        stream.map((item) => [item.key("views"), owner.key("take")]).distinct(),
      ),
    }))
    .run();
  expect(Sorted(read)).to.deep.equal(
    PerKind((items, take) =>
      [...new Set(items.map((item) => item.views))].map((views) => [
        views,
        take,
      ]),
    ),
  );
}

/** A group's stream collected inside a query nested in the mapper, by values reading its row. */
async function CollectReadingNestedRow(): Promise<void> {
  const read = await Items()
    .group("kind", (stream, kind) => ({
      kind,
      owners: Owners().map((owner) =>
        stream.map((item) => [item.key("views"), owner.key("take")]),
      ),
    }))
    .run();
  expect(Sorted(read)).to.deep.equal(
    PerKind((items, take) => items.map((item) => [item.views, take])),
  );
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

describe("a group's stream inside a query nested in the mapper, by values reading its row", function () {
  this.timeout(30_000);

  before(Seed);

  after(Unseed);

  it("keeps one value per distinct value", DistinctReadingNestedRow);
  it("collects every value", CollectReadingNestedRow);
  it("sums the values of a compound key's group", SumReadingNestedRow);
});
