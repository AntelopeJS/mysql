import { expect } from "chai";

import { Compile, CompiledRelation, Root } from "./pipeline-fixture";

const FROM_PEOPLE =
  "FROM `directory__people` AS `t0` WHERE (`t0`.`_instance` = ?)";

describe("the group stage", () => {
  it("groups by the declared column and selects it as the group value", () => {
    expect(
      Compile(
        Root().group("name", (stream, name) => ({ name, n: stream.count() })),
      ),
    ).to.deep.equal({
      sql: `SELECT JSON_OBJECT('name', CAST(JSON_QUOTE(\`t0\`.\`name\`) AS JSON), 'n', CAST(CAST(COUNT(*) AS DOUBLE) AS JSON)) AS \`value\` ${FROM_PEOPLE} GROUP BY \`t0\`.\`name\``,
      args: [""],
    });
  });

  it("groups by every part of a compound index, in its order, and hands the mapper a document of them", () => {
    const sql = Compile(
      Root().group("byAgeActive", (stream, group) => ({ group })),
    ).sql;
    expect(sql).to.include(
      "JSON_OBJECT('age', CAST(`t0`.`age` AS JSON), 'isActive', CAST((`t0`.`isActive`) <> 0 AS JSON))",
    );
    expect(sql).to.match(/GROUP BY `t0`\.`age`, `t0`\.`isActive`$/);
  });

  it("yields one row per group, so a count after it counts the groups", () => {
    const relation = CompiledRelation(
      Root().group("name", (stream, name) => ({ name })),
    );
    expect(relation.single).to.equal(false);
    expect(
      Compile(
        Root()
          .group("name", (stream, name) => ({ name }))
          .count(),
      ).sql,
    ).to.match(
      /^SELECT CAST\(COUNT\(\*\) AS DOUBLE\) AS `value` FROM \(SELECT /,
    );
  });

  it("drops the order ahead of it in the select that groups, since an order term beside a GROUP BY is no group's", () => {
    const sql = Compile(
      Root()
        .orderBy("age")
        .group("name", (stream, name) => ({ name })),
    ).sql;
    expect(sql).to.include(`${FROM_PEOPLE} GROUP BY \`t0\`.\`name\``);
    expect(sql).to.not.include("ORDER BY");
  });
});

describe("a group's sub-stream", () => {
  it("counts rows after a map, skipping none the map yields as null", () => {
    const sql = Compile(
      Root().group("name", (stream) => ({
        n: stream.map((row) => row.key("nickname")).count(),
      })),
    ).sql;
    expect(sql).to.include("'n', CAST(CAST(COUNT(*) AS DOUBLE) AS JSON)");
  });

  it("counts the values a pending distinct chose rather than the rows", () => {
    expect(
      Compile(
        Root().group("name", (stream) => ({
          n: stream.distinct("age").count(),
        })),
      ).sql,
    ).to.include("COUNT(DISTINCT `t0`.`age`)");
  });

  it("adds up a group's declared column as the whole-stream sum does", () => {
    const inGroup = Compile(
      Root().group("name", (stream) => ({ total: stream.sum("age") })),
    ).sql;
    expect(inGroup).to.include("CAST(COALESCE(SUM(`t0`.`age`), 0) AS DOUBLE)");
  });

  it("adds up the distinct values once a distinct is pending", () => {
    expect(
      Compile(
        Root().group("name", (stream) => ({
          total: stream.distinct("age").sum(),
        })),
      ).sql,
    ).to.include("SUM(DISTINCT `t0`.`age`)");
  });

  it("collects a stream it did not reduce into a JSON array, deduplicated by a distinct", () => {
    const relation = CompiledRelation(
      Root().group("name", (stream) => ({ ages: stream.distinct("age") })),
    );
    expect(relation.projection?.type).to.deep.equal({
      kind: "json",
      keys: { ages: { kind: "array", elem: { kind: "float" } } },
    });
    expect(
      Compile(
        Root().group("name", (stream) => ({ ages: stream.distinct("age") })),
      ).sql,
    ).to.include(
      "JSON_OBJECTAGG(COALESCE(CAST(CAST(`t0`.`age` AS JSON) AS CHAR), ''), CAST(`t0`.`age` AS JSON))",
    );
  });

  it("refuses a stage it cannot take, naming the stage and the position", () => {
    expect(() =>
      Compile(
        Root().group("name", (stream) => ({
          kept: stream.filter((row) => row.key("age").gt(1)),
        })),
      ),
    ).to.throw(
      "The 'filter' stage cannot appear in a group's sub-stream, though it is legal on the query outside the group",
    );
  });
});
