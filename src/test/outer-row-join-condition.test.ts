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

interface Read<T> {
  id: string;
  value: T;
}

/** Each owner's read as `expected` computes it for its `take`. */
function ExpectEach<T>(read: Read<T>[], expected: (take: number) => T): void {
  expect(read).to.have.deep.members(
    OWNERS.map((owner) => ({ id: owner._id, value: expected(owner.take) })),
  );
}

/** A condition that pairs an item with itself when the owner takes its view count. */
function SameItemTaken(owner: ValueProxy<Owner>) {
  return (left: ValueProxy<Item>, right: ValueProxy<Item>) =>
    left
      .key("_id")
      .eq(right.key("_id"))
      .and(right.key("views").eq(owner.key("take")));
}

/** Each item the owner takes, joined inner to itself on a condition that reads the owner. */
function TakenPairs(owner: ValueProxy<Owner>) {
  return Items()
    .orderBy("slug")
    .joinInner(Items(), SameItemTaken(owner), (left, right) => ({
      left: left.key("slug"),
      right: right.key("slug"),
    }));
}

/** The pair of the item at `index` among the ones the owner takes, by slug, or null past them. */
function TakenPairAt(take: number, index: number) {
  const item = BySlug(Viewed(take))[index];
  return item ? { left: item.slug, right: item.slug } : null;
}

async function CountOfInnerJoin(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: TakenPairs(owner).count(),
    }))
    .run();
  ExpectEach(read, (take) => Viewed(take).length);
}

async function CountOfLeftJoin(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: Items()
        .join(Items(), SameItemTaken(owner), (left) => left.key("slug"))
        .count(),
    }))
    .run();
  ExpectEach(read, () => AllBySlug().length);
}

async function NthOfSlicedJoin(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: TakenPairs(owner).slice(0, 5).nth(1),
    }))
    .run();
  ExpectEach(read, (take) => TakenPairAt(take, 1));
}

async function NthOfReorderedJoin(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: TakenPairs(owner).orderBy("right").nth(0),
    }))
    .run();
  ExpectEach(read, (take) => TakenPairAt(take, 0));
}

describe("a nested join whose condition reads its outer row", function () {
  this.timeout(30_000);

  before(Seed);

  after(Unseed);

  it("counts the pairs an inner join keeps", CountOfInnerJoin);
  it("counts every row of a left join", CountOfLeftJoin);
  it("takes the nth pair of a sliced join", NthOfSlicedJoin);
  it(
    "takes the nth pair of a join ordered by its mapped value",
    NthOfReorderedJoin,
  );
});
