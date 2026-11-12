import { expect } from "chai";
import type { ValueProxy } from "@antelopejs/interface-database";
import {
  AllBySlug,
  BySlug,
  ByText,
  CountsByKind,
  type Item,
  type KindCount,
  KindsViewed,
  OWNERS,
  type Owner,
  Owners,
  Items,
  Seed,
  SortedByKind,
  Stored,
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

/** The groups a query that reads the outer row folds its items into, by kind. */
function KindGroups(owner: ValueProxy<Owner>) {
  return Items()
    .filter((item) => item.key("views").eq(owner.key("take")))
    .group("kind", (stream, kind) => ({ kind, count: stream.count() }));
}

async function CountAfterGroup(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: KindGroups(owner).count(),
    }))
    .run();
  ExpectEach(read, (take) => KindsViewed(take).length);
}

async function FilterAfterGroup(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: KindGroups(owner).filter((group) => group.key("count").gt(1)),
    }))
    .run();
  ExpectEach(
    read.map((row) => ({ id: row.id, value: SortedByKind(row.value) })),
    (take) => CountsByKind(Viewed(take)).filter((group) => group.count > 1),
  );
}

/** Kinds from the last by text, a missing kind after every other one, as it sorts lowest. */
function Descending(left: KindCount, right: KindCount): number {
  if (left.kind === null || right.kind === null) {
    return left.kind === null ? 1 : -1;
  }
  return ByText(right.kind, left.kind);
}

async function OrderAndSliceAfterGroup(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: KindGroups(owner).orderBy("kind", "desc").slice(0, 2),
    }))
    .run();
  ExpectEach(read, (take) =>
    CountsByKind(Viewed(take)).sort(Descending).slice(0, 2),
  );
}

async function MapAfterGroup(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: KindGroups(owner).map((group) => group.key("kind")),
    }))
    .run();
  ExpectEach(
    read.map((row) => ({ id: row.id, value: [...row.value].sort(ByText) })),
    KindsViewed,
  );
}

/** `o3` reads no item, so the default stands in for the maximum of none. */
async function DefaultAfterAggregate(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: Items()
        .filter((item) => item.key("views").eq(owner.key("take")))
        .max("views")
        .default(-1),
    }))
    .run();
  ExpectEach(read, (take) => (Viewed(take).length > 0 ? take : -1));
}

/** The first `take` items of `take` views by slug, bounded by a count the outer row holds. */
function Sliced(owner: ValueProxy<Owner>) {
  return Items()
    .filter((item) => item.key("views").eq(owner.key("take")))
    .orderBy("slug")
    .slice(0, owner.key("take"));
}

function SlicedItems(take: number): Item[] {
  return BySlug(Viewed(take)).slice(0, take);
}

async function OrderAfterComputedSlice(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: Sliced(owner).orderBy("slug", "desc"),
    }))
    .run();
  ExpectEach(read, (take) => SlicedItems(take).reverse().map(Stored));
}

async function FilterAfterComputedSlice(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: Sliced(owner).filter((item) => item.key("kind").ne("a")),
    }))
    .run();
  ExpectEach(read, (take) =>
    SlicedItems(take)
      .filter((item) => item.kind !== "a")
      .map(Stored),
  );
}

async function MapAfterComputedSlice(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: Sliced(owner).map((item) => item.key("slug")),
    }))
    .run();
  ExpectEach(read, (take) => SlicedItems(take).map((item) => item.slug));
}

async function DistinctAfterComputedSlice(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: Sliced(owner).distinct("kind"),
    }))
    .run();
  ExpectEach(
    read.map((row) => ({ id: row.id, value: [...row.value].sort(ByText) })),
    (take) =>
      [...new Set(SlicedItems(take).map((item) => item.kind))].sort(ByText),
  );
}

async function CountAfterComputedSlice(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({ id: owner.key("_id"), value: Sliced(owner).count() }))
    .run();
  ExpectEach(read, (take) => SlicedItems(take).length);
}

async function GroupAfterComputedSlice(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: Sliced(owner).group("kind", (stream, kind) => ({
        kind,
        count: stream.count(),
      })),
    }))
    .run();
  ExpectEach(
    read.map((row) => ({ id: row.id, value: SortedByKind(row.value) })),
    (take) => CountsByKind(SlicedItems(take)),
  );
}

/** Only the bound reads the outer row: the first `take` items of all, by slug. */
async function GroupAfterSliceBoundByOuterRow(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: Items()
        .orderBy("slug")
        .slice(0, owner.key("take"))
        .map((item) => ({ sort: item.key("kind") }))
        .group("sort", (stream, sort) => ({
          kind: sort,
          count: stream.count(),
        })),
    }))
    .run();
  ExpectEach(
    read.map((row) => ({ id: row.id, value: SortedByKind(row.value) })),
    (take) => CountsByKind(AllBySlug().slice(0, take)),
  );
}

describe("stages after a nested group, aggregate or computed slice that reads its outer row", function () {
  this.timeout(30_000);

  before(Seed);

  after(Unseed);

  it("counts the groups", CountAfterGroup);
  it("filters the groups", FilterAfterGroup);
  it("orders and slices the groups", OrderAndSliceAfterGroup);
  it("maps the groups", MapAfterGroup);
  it("defaults the maximum of the rows", DefaultAfterAggregate);
  it("orders the rows a computed slice keeps", OrderAfterComputedSlice);
  it("filters the rows a computed slice keeps", FilterAfterComputedSlice);
  it("maps the rows a computed slice keeps", MapAfterComputedSlice);
  it("dedups the rows a computed slice keeps", DistinctAfterComputedSlice);
  it("counts the rows a computed slice keeps", CountAfterComputedSlice);
  it("groups the rows a computed slice keeps", GroupAfterComputedSlice);
  it(
    "groups the rows a slice bounded by the outer row alone keeps",
    GroupAfterSliceBoundByOuterRow,
  );
});
