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

/** An array stage in a nested group's select whose callback reads the outer row beside the key. */
async function OuterRowInArrayStageOfSelect(): Promise<void> {
  await ExpectRefused(() =>
    Owners()
      .map((owner) =>
        Items().group("views", (_stream, views) => ({
          views,
          sum: ValueProxy.constant([1, 2])
            .map((value) => value.add(views).add(owner.key("take")))
            .sum(),
        })),
      )
      .run(),
  );
}

/** An array stage in a nested group's stream whose callback reads the outer row. */
async function OuterRowInArrayStageOfStream(): Promise<void> {
  await ExpectRefused(() =>
    Owners()
      .map((owner) =>
        Items().group("views", (stream, views) => ({
          views,
          sum: stream
            .map((item) =>
              ValueProxy.constant([1, 2])
                .filter((value) => value.gt(owner.key("take")))
                .map((value) => value.add(item.key("views")))
                .sum(),
            )
            .sum(),
        })),
      )
      .run(),
  );
}

/** An array stage in a nested group's select whose callback reads the key, beside the outer row. */
async function KeyInArrayStageBesideOuterRow(): Promise<void> {
  await ExpectRefused(() =>
    Owners()
      .map((owner) =>
        Items().group("views", (_stream, views) => ({
          views,
          sum: ValueProxy.constant([1, 2])
            .map((value) => value.add(views))
            .sum()
            .add(owner.key("take")),
        })),
      )
      .run(),
  );
}

/** A slice bound reading the key in a nested group, with the outer row read beside it. */
async function KeyInSliceBoundBesideOuterRow(): Promise<void> {
  await ExpectRefused(() =>
    Owners()
      .map((owner) => ({
        take: owner.key("take"),
        groups: Items().group("views", (_stream, views) => ({
          views,
          sum: ValueProxy.constant([1, 2, 3]).slice(views).sum(),
          take: owner.key("take"),
        })),
      }))
      .run(),
  );
}

/** Array callbacks in a nested group reading the element of the callback around them. */
async function EnclosingElementInArrayStage(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      take: owner.key("take"),
      groups: Items().group("views", (_stream, views) => ({
        views,
        sum: ValueProxy.constant([1, 2])
          .map((outer) =>
            ValueProxy.constant([10, 20])
              .map((inner) => inner.add(outer))
              .sum(),
          )
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
      groups: VIEWS.map((views) => ({ views, sum: 66 })),
    })),
  );
}

/** An array stage in a nested group's stream that reads the stream's row, beside the outer row. */
async function StreamRowInArrayStage(): Promise<void> {
  const read = await Owners()
    .map((owner) => ({
      take: owner.key("take"),
      groups: Items().group("views", (stream, views) => ({
        views,
        take: owner.key("take"),
        sum: stream
          .map((item) =>
            ValueProxy.constant([1, 2])
              .filter((value) => value.gt(item.key("views")))
              .map((value) => value.add(item.key("views")))
              .sum(),
          )
          .sum(),
      })),
    }))
    .run();
  const ARRAY = [1, 2];
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
        sum:
          Viewed(views).length *
          ARRAY.filter((value) => value > views).reduce(
            (total, value) => total + value + views,
            0,
          ),
      })),
    })),
  );
}

/** An array stage reading the key in a group no query holds stays answered. */
async function KeyInArrayStageOfTopGroup(): Promise<void> {
  const read = await Items()
    .group("views", (_stream, views) => ({
      views,
      sum: ValueProxy.constant([1, 2])
        .map((value) => value.add(views))
        .sum(),
      owners: Owners().count(),
    }))
    .run();
  expect(
    [...read].sort((left, right) => left.views - right.views),
  ).to.deep.equal(
    VIEWS.map((views) => ({
      views,
      sum: 3 + 2 * views,
      owners: OWNERS.length,
    })),
  );
}

describe("an array stage in a group's mapper", function () {
  this.timeout(30_000);

  before(Seed);

  after(Unseed);

  it(
    "refuses an array stage in a nested group's select reading the outer row",
    OuterRowInArrayStageOfSelect,
  );
  it(
    "refuses an array stage in a nested group's stream reading the outer row",
    OuterRowInArrayStageOfStream,
  );
  it(
    "refuses an array stage in a nested group reading the key beside the outer row",
    KeyInArrayStageBesideOuterRow,
  );
  it(
    "refuses a slice bound in a nested group reading the key beside the outer row",
    KeyInSliceBoundBesideOuterRow,
  );
  it(
    "answers array callbacks in a nested group reading an enclosing element",
    EnclosingElementInArrayStage,
  );
  it(
    "answers an array stage in a nested group's stream reading the stream's row",
    StreamRowInArrayStage,
  );
  it(
    "answers an array stage reading the key in a group no query holds",
    KeyInArrayStageOfTopGroup,
  );
});
