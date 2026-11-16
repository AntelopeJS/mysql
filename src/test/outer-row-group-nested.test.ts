import { expect } from "chai";
import { ValueProxy } from "@antelopejs/interface-database";
import {
  OWNERS,
  Owners,
  Items,
  Seed,
  Unseed,
  Viewed,
} from "./outer-row-fixture";
import { ByNumber, ExpectRefused } from "./nested-group-read";

const VIEWS = [0, 1, 2, 3];
const TAKES = OWNERS.map((owner) => owner.take);

/** The group's key read alone in a query nested in the mapper. */
async function KeyBelow(): Promise<void> {
  await ExpectRefused(() =>
    Items()
      .group("views", (_stream, views) => ({
        views,
        value: Owners().map(() => views),
      }))
      .run(),
  );
}

/** The group's key filtering a query nested in the mapper. */
async function KeyInNestedFilter(): Promise<void> {
  await ExpectRefused(() =>
    Items()
      .group("views", (_stream, views) => ({
        views,
        value: Items()
          .filter((item) => item.key("views").eq(views))
          .count(),
      }))
      .run(),
  );
}

/** The group's key read two queries below, under a nested query of one row. */
async function KeyTwoBelow(): Promise<void> {
  await ExpectRefused(() =>
    Items()
      .group("views", (_stream, views) => ({
        views,
        value: Owners()
          .filter((owner) => owner.key("take").eq(2))
          .map(() =>
            Items()
              .filter((item) => item.key("views").eq(views))
              .map((item) => item.key("slug")),
          ),
      }))
      .run(),
  );
}

/** The group's stream deduplicated in a query nested in the mapper, by values reading its row. */
async function StreamDedupBelow(): Promise<void> {
  await ExpectRefused(() =>
    Items()
      .group("kind", (stream, kind) => ({
        kind,
        owners: Owners().map((owner) =>
          stream
            .map((item) => [item.key("views"), owner.key("take")])
            .distinct(),
        ),
      }))
      .run(),
  );
}

/** The group's stream collected in a query nested in the mapper, reading none of its row. */
async function StreamBelow(): Promise<void> {
  await ExpectRefused(() =>
    Items()
      .group("views", (stream, views) => ({
        views,
        owners: Owners().map((owner) => ({
          take: owner.key("take"),
          slugs: stream.map((item) => item.key("slug")),
        })),
      }))
      .run(),
  );
}

/** The group's stream counted in a query nested in the mapper. */
async function StreamCountBelow(): Promise<void> {
  await ExpectRefused(() =>
    Items()
      .group("views", (stream, views) => ({
        views,
        counts: Owners().map(() => stream.count()),
      }))
      .run(),
  );
}

/** A group nested in a map, whose mapper reads the map's row in a query nested in it. */
async function OuterRowBelowNestedGroup(): Promise<void> {
  await ExpectRefused(() =>
    Owners()
      .map((owner) =>
        Items().group("views", (_stream, views) => ({
          views,
          count: Owners()
            .filter((other) => other.key("take").eq(owner.key("take")))
            .count(),
        })),
      )
      .run(),
  );
}

/** A nested group's stream summing a value that reads only the outer row. */
async function OuterOnlySum(): Promise<void> {
  await ExpectRefused(() =>
    Owners()
      .map((owner) => ({
        take: owner.key("take"),
        groups: Items().group("views", (stream, views) => ({
          views,
          sum: stream.map(() => owner.key("take")).sum(),
        })),
      }))
      .run(),
  );
}

/** A nested group's stream collecting a value that reads only the outer row. */
async function OuterOnlyCollect(): Promise<void> {
  await ExpectRefused(() =>
    Owners()
      .map((owner) =>
        Items().group("views", (stream, views) => ({
          views,
          takes: stream.map(() => owner.key("take")),
        })),
      )
      .run(),
  );
}

/** A nested group's stream mapping an outer-only value again before summing it. */
async function OuterOnlyMappedAgain(): Promise<void> {
  await ExpectRefused(() =>
    Owners()
      .map((owner) =>
        Items().group("views", (stream, views) => ({
          views,
          sum: stream
            .map(() => owner.key("take"))
            .map((take) => take.add(1))
            .sum(),
        })),
      )
      .run(),
  );
}

/** A nested group's stream summing a value an array stage computes from the outer row. */
async function OuterOnlyThroughArray(): Promise<void> {
  await ExpectRefused(() =>
    Owners()
      .map((owner) =>
        Items().group("views", (stream, views) => ({
          views,
          sum: stream
            .map(() =>
              ValueProxy.constant([1, 2])
                .filter((value) => value.gt(owner.key("take")))
                .count(),
            )
            .sum(),
        })),
      )
      .run(),
  );
}

/** A nested group's stream summing its key beside the outer row stays answered. */
async function KeyBesideOuterRowInStream(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      take: owner.key("take"),
      groups: Items().group("views", (stream, views) => ({
        views,
        sum: stream.map(() => views.add(owner.key("take"))).sum(),
      })),
    }))
    .run();
  expect(
    read
      .map((owner) => ({
        take: owner.take,
        groups: [...owner.groups].sort(
          (left, right) => left.views - right.views,
        ),
      }))
      .sort((left, right) => left.take - right.take),
  ).to.deep.equal(
    [...TAKES].sort(ByNumber).map((take) => ({
      take,
      groups: VIEWS.map((views) => ({
        views,
        sum: Viewed(views).length * (views + take),
      })),
    })),
  );
}

/** A value bound in the group's select, such as an array element, read in a nested query. */
async function SelectValueBelow(): Promise<void> {
  await ExpectRefused(() =>
    Items()
      .group("views", (_stream, views) => ({
        views,
        counts: ValueProxy.constant([0, 2]).map((take) =>
          Owners()
            .filter((owner) => owner.key("take").eq(take))
            .count(),
        ),
      }))
      .run(),
  );
}

/** A query nested in the mapper that reads its own rows and constants only stays answered. */
async function OwnRowsBelow(): Promise<void> {
  const read = await Items()
    .group("views", (stream, views) => ({
      views,
      count: stream.count(),
      takes: Owners().map((owner) => owner.key("take")),
      over: Owners()
        .filter((owner) => owner.key("take").gt(1))
        .count(),
    }))
    .run();
  expect(
    read
      .map((group) => ({ ...group, takes: [...group.takes].sort(ByNumber) }))
      .sort((left, right) => left.views - right.views),
  ).to.deep.equal(
    VIEWS.map((views) => ({
      views,
      count: Viewed(views).length,
      takes: [...TAKES].sort(ByNumber),
      over: TAKES.filter((take) => take > 1).length,
    })),
  );
}

/** A group nested in a map reads the map's row in its own select and stream. */
async function OuterRowInNestedGroupSelect(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      take: owner.key("take"),
      groups: Items().group("views", (stream, views) => ({
        views,
        take: owner.key("take"),
        sum: stream
          .map((item) => item.key("views").add(owner.key("take")))
          .sum(),
      })),
    }))
    .run();
  expect(
    read
      .map((owner) => ({
        take: owner.take,
        groups: [...owner.groups].sort(
          (left, right) => left.views - right.views,
        ),
      }))
      .sort((left, right) => left.take - right.take),
  ).to.deep.equal(
    [...TAKES].sort(ByNumber).map((take) => ({
      take,
      groups: VIEWS.map((views) => ({
        views,
        take,
        sum: Viewed(views).length * (views + take),
      })),
    })),
  );
}

describe("a query nested in a group's mapper", function () {
  this.timeout(30_000);

  before(Seed);

  after(Unseed);

  it("refuses the group's key read in it", KeyBelow);
  it("refuses the group's key filtering it", KeyInNestedFilter);
  it("refuses the group's key read two queries below", KeyTwoBelow);
  it("refuses the group's stream deduplicated in it", StreamDedupBelow);
  it("refuses the group's stream collected in it", StreamBelow);
  it("refuses the group's stream counted in it", StreamCountBelow);
  it(
    "refuses a row from outside a nested group read in it",
    OuterRowBelowNestedGroup,
  );
  it(
    "refuses a nested group's stream summing only the outer row",
    OuterOnlySum,
  );
  it(
    "refuses a nested group's stream collecting only the outer row",
    OuterOnlyCollect,
  );
  it(
    "refuses a value bound in the group's select read in it",
    SelectValueBelow,
  );
  it("refuses an outer-only stream value mapped again", OuterOnlyMappedAgain);
  it(
    "refuses an outer-only stream value computed by an array stage",
    OuterOnlyThroughArray,
  );
  it(
    "answers a nested group's key summed beside the outer row",
    KeyBesideOuterRowInStream,
  );
  it("answers one that reads its own rows and constants", OwnRowsBelow);
  it(
    "leaves a nested group reading its outer row in its own select",
    OuterRowInNestedGroupSelect,
  );
});
