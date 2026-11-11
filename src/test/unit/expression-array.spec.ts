import { expect } from "chai";
import { ValueProxy } from "@antelopejs/interface-database";

import { Compile, ProfilesRoot, TaggedRoot } from "./pipeline-fixture";
import { Occurrences, Projected } from "./expression-fixture";

const SKILLS = "`t0`.`skills`";
const ARRAY_GUARD = `(CASE WHEN (JSON_TYPE(${SKILLS}) IN ('ARRAY' COLLATE utf8mb4_bin)) THEN `;

function Skills(read: Parameters<ReturnType<typeof ProfilesRoot>["map"]>[0]) {
  return Compile(ProfilesRoot().map(read));
}

describe("The array stages", () => {
  it("measure an array behind a guard, since a scalar reads as a one-element list", () => {
    expect(Projected(Skills((doc) => doc.key("skills").count()))).to.equal(
      `${ARRAY_GUARD}CAST(JSON_LENGTH(${SKILLS}) AS DOUBLE) END)`,
    );
    expect(Projected(Skills((doc) => doc.key("skills").isempty()))).to.equal(
      `${ARRAY_GUARD}(JSON_LENGTH(${SKILLS}) = 0) END)`,
    );
  });

  it("spell a guarded operand once for the guard and once for what it guards", () => {
    const sql = Projected(Skills((doc) => doc.key("skills").count()));
    expect(Occurrences(sql, SKILLS)).to.equal(2);
  });

  it("index from the end for a negative position, with the position clamped and bound", () => {
    const bound = Skills((doc) => doc.key("skills").index(-1));
    const sql = Projected(bound);
    expect(sql).to.include("CONCAT('last-', CAST(-1 - ");
    expect(sql).to.include(
      "LEAST(GREATEST(TRUNCATE(CAST(? AS DOUBLE), 0), -2147483648), 2147483647)",
    );
    expect(bound.args.slice(0, 2)).to.deep.equal([-1, -1]);
  });

  it("test an element with MEMBER OF and no guard, naming the column as its multi-valued index is built on", () => {
    const sql = Projected(Skills((doc) => doc.key("skills").includes("ts")));
    expect(sql).to.equal(
      `(CAST(JSON_QUOTE(?) AS JSON) MEMBER OF (JSON_EXTRACT(${SKILLS}, '$')))`,
    );
  });

  it("test an element of a list no multi-valued index covers against the bare column", () => {
    const sql = Projected(
      Compile(TaggedRoot().map((doc) => doc.key("labels").includes("a"))),
    );
    expect(sql).to.equal(
      "(CAST(JSON_QUOTE(?) AS JSON) MEMBER OF (`t0`.`labels`))",
    );
  });

  it("slice onto 1-based ordinals, the lower bound strict and the upper inclusive", () => {
    const sql = Projected(Skills((doc) => doc.key("skills").slice(1, 3)));
    expect(sql).to.include("WHERE (`t1`.`ord` > (CASE WHEN");
    expect(sql).to.include("AND `t1`.`ord` <= (CASE WHEN");
  });

  it("slice with no upper bound by leaving the upper predicate out", () => {
    const sql = Projected(Skills((doc) => doc.key("skills").slice(1)));
    expect(sql).to.not.include("`t1`.`ord` <=");
  });

  it("count a negative bound back from the length of the very array it walks", () => {
    const sql = Projected(Skills((doc) => doc.key("skills").slice(-2)));
    expect(sql).to.include(
      `GREATEST(JSON_LENGTH(${SKILLS}) + TRUNCATE(CAST(? AS DOUBLE), 0), 0)`,
    );
  });

  it("aggregate every walk in the order of its ordinal, and empty to [] rather than NULL", () => {
    for (const sql of [
      Projected(Skills((doc) => doc.key("skills").slice(0, 1))),
      Projected(
        Skills((doc) => doc.key("skills").map((skill) => skill.upcase())),
      ),
      Projected(
        Skills((doc) => doc.key("skills").filter((skill) => skill.eq("ts"))),
      ),
    ]) {
      expect(sql).to.include("ORDER BY `t1`.`ord` SEPARATOR ','");
      expect(sql).to.include("JSON_ARRAY())");
    }
  });

  it("bind the element of a map at the declared type, reaching UPPER without a JSON round trip", () => {
    const sql = Projected(
      Skills((doc) => doc.key("skills").map((skill) => skill.upcase())),
    );
    expect(sql).to.include("UPPER((CASE WHEN (JSON_TYPE(`t1`.`value`)");
  });

  it("filter on the predicate the callback answers, keeping the element untouched", () => {
    const sql = Projected(
      Skills((doc) => doc.key("skills").filter((skill) => skill.eq("ts"))),
    );
    expect(sql).to.include("COALESCE(CAST(`t1`.`value` AS CHAR), 'null')");
    expect(sql).to.include("WHERE ((CASE WHEN (JSON_TYPE(`t1`.`value`)");
  });

  it("give a nested walk an alias of its own", () => {
    const sql = Projected(
      Skills((doc) =>
        doc
          .key("skills")
          .map(() => doc.key("skills").map((skill) => skill.upcase())),
      ),
    );
    expect(sql).to.include("AS `t1`");
    expect(sql).to.include("AS `t2`");
    expect(Occurrences(sql, "JSON_TABLE(")).to.equal(2);
  });
});

describe("The array reducers", () => {
  it("sum an empty array to 0 and leave an average of none NULL", () => {
    const sum = Projected(
      Compile(ProfilesRoot().map(() => ValueProxy.constant([1, 2]).sum())),
    );
    expect(sum).to.include("COALESCE(SUM(");
    const avg = Projected(
      Compile(ProfilesRoot().map(() => ValueProxy.constant([1, 2]).avg())),
    );
    expect(avg).to.include("AVG(");
    expect(avg).to.not.include("COALESCE(AVG");
  });

  it("read each element through the guarded projection of the declared type, so one of another type is skipped", () => {
    const sql = Projected(Skills((doc) => doc.key("skills").min()));
    expect(sql).to.include(
      "MIN((CASE WHEN (JSON_TYPE(`t1`.`value`) IN ('STRING'",
    );
  });

  it("read each element as a number for a sum, whatever the array declares", () => {
    const sql = Projected(
      Compile(ProfilesRoot().map(() => ValueProxy.constant([1, 2]).sum())),
    );
    expect(sql).to.include("CAST(`t1`.`value` AS DOUBLE)");
  });
});
