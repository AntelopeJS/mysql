import { expect } from "chai";
import { ValueProxy } from "@antelopejs/interface-database";
import { GetDialect } from "../connection";
import {
  BySlug,
  OWNERS,
  Owners,
  Items,
  Seed,
  Unseed,
  Viewed,
} from "./outer-row-fixture";

const VIEWS = [0, 1, 2, 3];
const TAKES = OWNERS.map((owner) => owner.take).sort(ByNumber);

function ByNumber(left: number, right: number): number {
  return left - right;
}

/** Runs a query the module refuses as it builds it, and checks the refusal's code. */
async function ExpectRefused(run: () => Promise<object>): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).to.have.property(
      "code",
      "ANTELOPEJS_MYSQL_NESTED_GROUP_READ",
    );
    return;
  }
  expect.fail("the query was run, not refused");
}

function Slugs(views: number): string[] {
  return BySlug(Viewed(views)).map((item) => item.slug);
}

interface OwnerGroup {
  views: number;
  take: number;
}

/** The groups of every owner in one list, by `take` and then by view count. */
function Flat<T extends OwnerGroup>(read: T[][]): T[] {
  return read
    .flat()
    .sort((left, right) => left.take - right.take || left.views - right.views);
}

/** What {@link Flat} answers where `fields` computes each group's other fields. */
function PerOwner<T extends object>(
  fields: (views: number, take: number) => T,
): (OwnerGroup & T)[] {
  return TAKES.flatMap((take) =>
    VIEWS.map((views) => ({ views, take, ...fields(views, take) })),
  );
}

/**
 * An array stage reads each group's key beside the outer row. MySQL read the key inside the
 * stage's subquery off the group before it, for every owner after the first.
 */
async function KeyInArrayStageBesideOuterRow(): Promise<void> {
  const read = await Owners()
    .map((owner) =>
      Items().group("views", (_stream, views) => ({
        views,
        take: owner.key("take"),
        sum: ValueProxy.constant([1, 2])
          .map((value) => value.add(views))
          .sum()
          .add(owner.key("take")),
      })),
    )
    .run();
  expect(Flat(read)).to.deep.equal(
    PerOwner((views, take) => ({ sum: 3 + 2 * views + take })),
  );
}

/** {@link KeyInArrayStageBesideOuterRow} where a `merge` and its `values()` read the key. */
async function KeyInMergeBesideOuterRow(): Promise<void> {
  const read = await Owners()
    .map((owner) =>
      Items().group("views", (_stream, views) => ({
        views,
        take: owner.key("take"),
        merged: ValueProxy.constant({ a: 1, b: 2 }).merge({
          v: views,
          t: owner.key("take"),
        }),
        sum: ValueProxy.constant({ a: 1, b: 2 })
          .merge({ v: views, t: owner.key("take") })
          .values()
          .sum(),
      })),
    )
    .run();
  expect(Flat(read)).to.deep.equal(
    PerOwner((views, take) => ({
      merged: { a: 1, b: 2, v: views, t: take },
      sum: 3 + views + take,
    })),
  );
}

/** {@link KeyInArrayStageBesideOuterRow} where a query nested in the mapper reads the key. */
async function KeyInNestedQueryOfNestedGroup(): Promise<void> {
  const read = await Owners()
    .map((owner) =>
      Items().group("views", (_stream, views) => ({
        views,
        take: owner.key("take"),
        above: Owners()
          .filter((other) => other.key("take").gt(views))
          .count(),
      })),
    )
    .run();
  expect(Flat(read)).to.deep.equal(
    PerOwner((views) => ({
      above: TAKES.filter((take) => take > views).length,
    })),
  );
}

/**
 * The stream aggregates and collects a value that reads the outer row and no column of the group's
 * rows. Both engines ran the aggregate in the outer query, which answered one owner for all.
 */
async function OuterRowOnlyInStream(): Promise<void> {
  const read = await Owners()
    .map((owner) =>
      Items().group("views", (stream, views) => ({
        views,
        take: owner.key("take"),
        sum: stream.map(() => owner.key("take")).sum(),
        takes: stream.map(() => owner.key("take")),
      })),
    )
    .run();
  expect(Flat(read)).to.deep.equal(
    PerOwner((views, take) => ({
      sum: take * Viewed(views).length,
      takes: Viewed(views).map(() => take),
    })),
  );
}

/**
 * A query nested in the mapper yields the key alone, or a query of its own reading the key. Both
 * engines ran its aggregate in the group's select, which failed with `Subquery returns more than 1
 * row` or answered every group's rows.
 */
async function KeyAloneInNestedQuery(): Promise<void> {
  const read = await Items()
    .group("views", (_stream, views) => ({
      views,
      keys: Owners().map(() => views),
      sum: Owners()
        .map(() => views)
        .sum(),
      slugs: Owners()
        .filter((owner) => owner.key("take").eq(2))
        .map(() =>
          Items()
            .filter((item) => item.key("views").eq(views))
            .map((item) => item.key("slug")),
        ),
    }))
    .run();
  expect(
    read
      .map((group) => ({
        ...group,
        slugs: group.slugs.map((slugs) => [...slugs].sort()),
      }))
      .sort((left, right) => left.views - right.views),
  ).to.deep.equal(
    VIEWS.map((views) => ({
      views,
      keys: TAKES.map(() => views),
      sum: TAKES.length * views,
      slugs: [Slugs(views)],
    })),
  );
}

/**
 * The stream counted in a query nested in the mapper, and in a `merge` an array stage reads.
 * `COUNT(*)` ran in the nested query, which failed with `Invalid use of group function`, or in the
 * stage's subquery on MySQL, which counted its one row.
 */
async function CountInNestedQueryAndArrayStage(): Promise<void> {
  const read = await Items()
    .group("views", (stream, views) => ({
      views,
      counts: Owners().map(() => stream.count()),
      sum: ValueProxy.constant({ a: 1, b: 2 })
        .merge({ n: stream.count() })
        .values()
        .sum(),
    }))
    .run();
  expect(read.sort((left, right) => left.views - right.views)).to.deep.equal(
    VIEWS.map((views) => ({
      views,
      counts: TAKES.map(() => Viewed(views).length),
      sum: 3 + Viewed(views).length,
    })),
  );
}

/**
 * A group nested in the mapper counts the outer stream. MariaDB counted the inner group's rows,
 * and then answered one inner group's key for all of them, so it refuses; MySQL answers.
 */
async function OuterStreamInNestedGroup(): Promise<void> {
  const run = () =>
    Items()
      .group("views", (stream, views) => ({
        views,
        takes: Owners().group("take", (_owners, take) => ({
          take,
          count: stream.count(),
        })),
      }))
      .run();
  if (GetDialect().id === "mariadb") {
    await ExpectRefused(run);
    return;
  }
  const read = await run();
  expect(
    read
      .map((group) => ({
        ...group,
        takes: [...group.takes].sort((left, right) => left.take - right.take),
      }))
      .sort((left, right) => left.views - right.views),
  ).to.deep.equal(
    VIEWS.map((views) => ({
      views,
      takes: TAKES.map((take) => ({ take, count: Viewed(views).length })),
    })),
  );
}

/**
 * The stream counted in a map's callback over an array. MariaDB failed with `Invalid use of group
 * function`, and answers another value once the count is tied to the group's rows, so it refuses;
 * MySQL answers.
 */
async function StreamInArrayStageCallback(): Promise<void> {
  const run = () =>
    Items()
      .group("views", (stream, views) => ({
        views,
        sum: ValueProxy.constant([1, 2])
          .map((value) =>
            ValueProxy.constant({ a: 1 })
              .merge({ n: stream.count() })
              .values()
              .sum()
              .add(value),
          )
          .sum(),
      }))
      .run();
  if (GetDialect().id === "mariadb") {
    await ExpectRefused(run);
    return;
  }
  const read = await run();
  expect(read.sort((left, right) => left.views - right.views)).to.deep.equal(
    VIEWS.map((views) => ({ views, sum: 5 + 2 * Viewed(views).length })),
  );
}

/**
 * The stream read in an ordered and sliced query nested in the mapper. MariaDB answered one
 * owner's row twice, so it refuses; MySQL answers.
 */
async function StreamInOrderedSlice(): Promise<void> {
  const run = () =>
    Items()
      .group("views", (stream, views) => ({
        views,
        owners: Owners()
          .orderBy("take")
          .slice(0, 2)
          .map((owner) => ({
            take: owner.key("take"),
            slugs: stream.map((item) => item.key("slug")),
          })),
      }))
      .run();
  if (GetDialect().id === "mariadb") {
    await ExpectRefused(run);
    return;
  }
  const read = await run();
  expect(
    read
      .map((group) => ({
        ...group,
        owners: group.owners.map((owner) => ({
          ...owner,
          slugs: [...owner.slugs].sort(),
        })),
      }))
      .sort((left, right) => left.views - right.views),
  ).to.deep.equal(
    VIEWS.map((views) => ({
      views,
      owners: TAKES.slice(0, 2).map((take) => ({
        take,
        slugs: Slugs(views),
      })),
    })),
  );
}

describe("a group's key, stream and outer row read inside its mapper", function () {
  this.timeout(30_000);

  before(Seed);

  after(Unseed);

  it(
    "reads each group's key in an array stage beside the outer row",
    KeyInArrayStageBesideOuterRow,
  );
  it(
    "reads each group's key in a merge and its values beside the outer row",
    KeyInMergeBesideOuterRow,
  );
  it(
    "reads each group's key in a query nested in a group nested in another query",
    KeyInNestedQueryOfNestedGroup,
  );
  it(
    "aggregates over the group's rows a value that reads only the outer row",
    OuterRowOnlyInStream,
  );
  it(
    "collects and sums the key in a query nested in the mapper",
    KeyAloneInNestedQuery,
  );
  it(
    "counts the stream in a nested query and in an array stage",
    CountInNestedQueryAndArrayStage,
  );
  it(
    "answers or refuses a group nested in the mapper that counts the outer stream",
    OuterStreamInNestedGroup,
  );
  it(
    "answers or refuses the stream counted in a map's callback over an array",
    StreamInArrayStageCallback,
  );
  it(
    "answers or refuses the stream read in an ordered slice nested in the mapper",
    StreamInOrderedSlice,
  );
});
