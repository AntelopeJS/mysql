import { expect } from "chai";
import {
  AssertNoRareValue,
  type FixtureCount,
  type ResultValue,
} from "@antelopejs/interface-database-catalog/testing";
import {
  type ColumnProfile,
  type RelationProfile,
  Profile,
} from "@antelopejs/interface-database-catalog";

import { Received } from "./received";

/** The rows of `sales.grades` and `sales.snowflakes` that hold each value, as the fixture inserts them. */
const FIXTURE_COUNTS = new Map<string, FixtureCount[]>(
  Object.entries({
    grade: [
      { value: "bronze", rows: 4 },
      { value: "silver", rows: 5 },
      { value: "gold", rows: 8 },
      { value: "platinum", rows: 1 },
    ],
    level: [
      { value: 7001, rows: 4 },
      { value: 7002, rows: 5 },
      { value: 7008, rows: 5 },
      { value: 7009, rows: 4 },
    ],
    ref: Array.from({ length: 5 }, (_, index) => ({
      value: 1500000000000000001n + BigInt(index) + "",
      rows: 1,
    })),
  }),
);

async function ProfiledColumn(
  column: string,
  relation = "sales.grades",
): Promise<{
  profile: ColumnProfile | undefined;
  whole: RelationProfile;
  sets: ResultValue[];
}> {
  const { answer, sets } = await Received(() =>
    Profile({ relation, columns: [column] }),
  );
  return {
    profile: answer.columns.find((profiled) => profiled.name === column),
    whole: answer,
    sets,
  };
}

function AssertNoRare(
  column: string,
  { whole, sets }: { whole: RelationProfile; sets: ResultValue[] },
): void {
  AssertNoRareValue({
    profile: whole,
    results: sets,
    counts: { [column]: FIXTURE_COUNTS.get(column) ?? [] },
  });
}

describe("the range of an external column", function () {
  this.timeout(120_000);

  it("ends an enum column at labels seen at least 5 times, so no result set holds a rarer one beside the declared type", async () => {
    const profiled = await ProfiledColumn("grade");
    expect(profiled.profile?.range).to.deep.equal({
      status: "ok",
      value: { min: "gold", max: "silver" },
    });
    AssertNoRare("grade", profiled);
  });

  it("ends an integer column at values seen 5 times, past values seen 4 times", async () => {
    const profiled = await ProfiledColumn("level");
    expect(profiled.profile?.range).to.deep.equal({
      status: "ok",
      value: { min: 7002, max: 7008 },
    });
    AssertNoRare("level", profiled);
  });

  it("answers empty for an integer column whose every value is seen once", async () => {
    const { profile } = await ProfiledColumn("id");
    expect(profile?.range).to.deep.equal({ status: "error", code: "empty" });
  });

  it("counts bigint values one double cannot tell apart as distinct values, so five seen once each stay unnamed", async () => {
    const profiled = await ProfiledColumn("ref", "sales.snowflakes");
    expect(profiled.profile?.range).to.deep.equal({
      status: "error",
      code: "empty",
    });
    expect(profiled.profile?.categories).to.deep.equal({
      status: "ok",
      value: { values: [], other: 5 },
    });
    AssertNoRare("ref", profiled);
  });
});
