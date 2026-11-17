import { expect } from "chai";
import { type Stream, ValueProxy } from "@antelopejs/interface-database";
import { GetDialect } from "../connection";
import {
  type Item,
  Items,
  OWNERS,
  Owners,
  Seed,
  Unseed,
  Viewed,
} from "./outer-row-fixture";

const VIEWS = [0, 1, 2, 3];
const ELEMENTS = [1, 2, 3, 4, 5, 6, 7, 8];

interface Placement {
  name: string;
  read: (stream: Stream<Item>) => ValueProxy<number>;
  expected: (count: number) => number;
}

/**
 * Reads of a group's stream in an array stage's bounds or filter callback, which sit outside the
 * aggregate that walks the elements. 0.2.4 answered each of them on both engines; a rule that
 * refuses every read of the stream inside an array stage fails them on MariaDB.
 */
const OUTSIDE_THE_WALK_AGGREGATE: Placement[] = [
  {
    name: "a slice's end bound",
    read: (stream) =>
      ValueProxy.constant(ELEMENTS).slice(0, Counted(stream)).sum(),
    expected: (count) => Sum(ELEMENTS.slice(0, count)),
  },
  {
    name: "a slice's start bound",
    read: (stream) =>
      ValueProxy.constant(ELEMENTS).slice(Counted(stream)).sum(),
    expected: (count) => Sum(ELEMENTS.slice(count)),
  },
  {
    name: "a filter's callback",
    read: (stream) =>
      ValueProxy.constant(ELEMENTS)
        .filter((element) => element.gt(Counted(stream)))
        .count(),
    expected: (count) => ELEMENTS.filter((element) => element > count).length,
  },
];

/** The stream's count as a value, which an array stage takes as a bound or compares to an element. */
function Counted(stream: Stream<Item>): ValueProxy<number> {
  return ValueProxy.constant({ n: 0 }).merge({ n: stream.count() }).key("n");
}

function Sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function GroupRead(placement: Placement) {
  return Items().group("views", (stream, views) => ({
    views,
    read: placement.read(stream),
  }));
}

function Expected(placement: Placement) {
  return VIEWS.map((views) => ({
    views,
    read: placement.expected(Viewed(views).length),
  }));
}

function ByViews<T extends { views: number }>(groups: T[]): T[] {
  return [...groups].sort((left, right) => left.views - right.views);
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

describe("a group's stream read in an array stage", function () {
  this.timeout(30_000);

  before(Seed);

  after(Unseed);

  for (const placement of OUTSIDE_THE_WALK_AGGREGATE) {
    it(`answers the stream counted in ${placement.name}`, async () => {
      const read = await GroupRead(placement).run();
      expect(ByViews(read)).to.deep.equal(Expected(placement));
    });

    it(`answers the stream counted in ${placement.name}, in a group nested in another query`, async () => {
      const read = await Owners()
        .map(() => GroupRead(placement))
        .run();
      expect(read.map(ByViews)).to.deep.equal(
        OWNERS.map(() => Expected(placement)),
      );
    });
  }

  it("answers or refuses the stream counted alone in a map's callback", async () => {
    const run = () =>
      Items()
        .group("views", (stream, views) => ({
          views,
          read: ValueProxy.constant([1, 2]).map(() => stream.count()),
        }))
        .run();
    if (GetDialect().id === "mariadb") {
      await ExpectRefused(run);
      return;
    }
    expect(ByViews(await run())).to.deep.equal(
      VIEWS.map((views) => ({
        views,
        read: [Viewed(views).length, Viewed(views).length],
      })),
    );
  });
});
