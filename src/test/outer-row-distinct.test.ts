import { expect } from "chai";
import type { ValueProxy } from "@antelopejs/interface-database";
import {
  ByText,
  KindsViewed,
  OWNERS,
  type Owner,
  Owners,
  Items,
  Seed,
  Unseed,
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

/** The kinds of the items of `take` views, deduplicated by a query that reads the outer row. */
function Kinds(owner: ValueProxy<Owner>) {
  return Items()
    .filter((item) => item.key("views").eq(owner.key("take")))
    .distinct("kind");
}

function SortedKinds(read: Read<(string | null)[]>[]) {
  return read.map((row) => ({
    id: row.id,
    value: [...row.value].sort(ByText),
  }));
}

async function MapAfterDistinct(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: Kinds(owner).map((kind) => ({ kind })),
    }))
    .run();
  ExpectEach(
    read.map((row) => ({
      id: row.id,
      value: row.value.map((entry) => entry.kind).sort(ByText),
    })),
    KindsViewed,
  );
}

async function MapReadingOuterRowAfterDistinct(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: Kinds(owner).map((kind) => ({ kind, take: owner.key("take") })),
    }))
    .run();
  ExpectEach(
    read.map((row) => ({
      id: row.id,
      value: [...row.value].sort((left, right) =>
        ByText(left.kind, right.kind),
      ),
    })),
    (take) => KindsViewed(take).map((kind) => ({ kind, take })),
  );
}

async function FilterAfterDistinct(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      id: owner.key("_id"),
      value: Kinds(owner).filter((kind) => kind.ne("a")),
    }))
    .run();
  ExpectEach(SortedKinds(read), (take) =>
    KindsViewed(take).filter((kind) => kind !== "a"),
  );
}

describe("stages after a nested distinct that reads its outer row", function () {
  this.timeout(30_000);

  before(Seed);

  after(Unseed);

  it("maps the values", MapAfterDistinct);
  it("maps the values with the outer row", MapReadingOuterRowAfterDistinct);
  it("filters the values", FilterAfterDistinct);
});
