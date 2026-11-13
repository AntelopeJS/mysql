import { expect } from "chai";
import type { ValueProxy } from "@antelopejs/interface-database";
import {
  AllBySlug,
  BySlug,
  type Item,
  Items,
  OWNERS,
  type Owner,
  Owners,
  Seed,
  Unseed,
  Viewed,
} from "./outer-row-fixture";

interface Pair {
  left: string;
  right: string | null;
}

interface Read {
  id: string;
  value: Pair[];
}

/** The items a query that reads the outer row selects. */
function Mine(owner: ValueProxy<Owner>) {
  return Items().filter((item) => item.key("views").eq(owner.key("take")));
}

function BySlugs(left: Pair, right: Pair): number {
  return `${left.left}/${left.right}`.localeCompare(
    `${right.left}/${right.right}`,
  );
}

/** Each owner's pairs as `expected` computes them for its `take`, in any order. */
function ExpectEach(read: Read[], expected: (take: number) => Pair[]): void {
  expect(
    read.map((row) => ({ id: row.id, value: [...row.value].sort(BySlugs) })),
  ).to.have.deep.members(
    OWNERS.map((owner) => ({
      id: owner._id,
      value: expected(owner.take).sort(BySlugs),
    })),
  );
}

/** The pairs of an item with itself, for the items the right side keeps. */
function SelfPairs(kept: readonly Item[]): Pair[] {
  return kept.map((item) => ({ left: item.slug, right: item.slug }));
}

async function InnerJoinOfRowsThatReadTheOuterRow(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: Items().joinInner(
        Mine(owner),
        (left, right) => left.key("_id").eq(right.key("_id")),
        (left, right) => ({ left: left.key("slug"), right: right.key("slug") }),
      ),
    }))
    .run();
  ExpectEach(read, (take) => SelfPairs(Viewed(take)));
}

async function LeftJoinOfRowsThatReadTheOuterRow(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: Items().join(
        Mine(owner),
        (left, right) => left.key("_id").eq(right.key("_id")),
        (left, right) => ({ left: left.key("slug"), right: right.key("slug") }),
      ),
    }))
    .run();
  ExpectEach(read, (take) =>
    AllBySlug().map((item) => ({
      left: item.slug,
      right: item.views === take ? item.slug : null,
    })),
  );
}

async function InnerJoinOfSlicedRowsThatReadTheOuterRow(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: Items().joinInner(
        Mine(owner).orderBy("slug").slice(0, 2),
        (left, right) => left.key("_id").eq(right.key("_id")),
        (left, right) => ({ left: left.key("slug"), right: right.key("slug") }),
      ),
    }))
    .run();
  ExpectEach(read, (take) => SelfPairs(BySlug(Viewed(take)).slice(0, 2)));
}

describe("a nested join whose joined query reads its outer row", function () {
  this.timeout(30_000);

  before(Seed);

  after(Unseed);

  it("pairs the rows an inner join keeps", InnerJoinOfRowsThatReadTheOuterRow);
  it(
    "keeps every row of a left join, paired where the joined query matches",
    LeftJoinOfRowsThatReadTheOuterRow,
  );
  it(
    "pairs the rows a sliced joined query keeps",
    InnerJoinOfSlicedRowsThatReadTheOuterRow,
  );
});
