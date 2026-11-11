import { expect } from "chai";

import { Compile, CompiledRelation, Root } from "./pipeline-fixture";

const FROM_PEOPLE =
  "FROM `directory__people` AS `t0` WHERE (`t0`.`_instance` = ?)";

describe("the sum and avg stages", () => {
  it("sums the declared column and answers 0 over no row, as ReQL's sum does", () => {
    expect(Compile(Root().sum("age")).sql).to.equal(
      `SELECT CAST(COALESCE(SUM(\`t0\`.\`age\`), 0) AS DOUBLE) AS \`value\` ${FROM_PEOPLE}`,
    );
  });

  it("leaves an average over no row null rather than 0", () => {
    expect(Compile(Root().avg("age")).sql).to.equal(
      `SELECT CAST(AVG(\`t0\`.\`age\`) AS DOUBLE) AS \`value\` ${FROM_PEOPLE}`,
    );
  });

  it("reads an overflow member only where it holds a JSON number", () => {
    const sql = Compile(Root().sum("rev")).sql;
    expect(sql).to.include("SUM((CASE WHEN (JSON_TYPE(");
    expect(sql).to.include("THEN CAST(JSON_EXTRACT(`t0`.`_extra`");
  });

  it("drops the order terms of a sorted stream, which cannot change a sum", () => {
    const relation = CompiledRelation(Root().orderBy("age").sum("age"));
    expect(relation.orderBy).to.deep.equal([]);
    expect(relation.single).to.equal(true);
  });
});

describe("the min and max stages", () => {
  it("keep a text column a text answer, uncast", () => {
    const relation = CompiledRelation(Root().min("name"));
    expect(relation.projection?.type).to.deep.equal({ kind: "text" });
    expect(Compile(Root().min("name")).sql).to.include(
      "(MIN(`t0`.`name`)) AS `value`",
    );
  });

  it("keep an instant column an instant", () => {
    const relation = CompiledRelation(Root().max("joined"));
    expect(relation.projection?.type).to.deep.equal({ kind: "timestamp" });
  });

  it("compare a boolean as a number, as arr_min and arr_max do", () => {
    expect(Compile(Root().min("isActive")).sql).to.include(
      "CAST(MIN(CAST(`t0`.`isActive` AS DOUBLE)) AS DOUBLE)",
    );
  });
});

describe("the distinct stage", () => {
  it("dedups one named field and yields it as the value", () => {
    expect(Compile(Root().distinct("isActive")).sql).to.equal(
      `SELECT DISTINCT \`t0\`.\`isActive\` AS \`value\` ${FROM_PEOPLE}`,
    );
  });

  it("dedups whole rows when no field is named, staying row-shaped", () => {
    const relation = CompiledRelation(Root().distinct());
    expect(relation.distinct).to.equal(true);
    expect(relation.projection).to.equal(undefined);
    expect(relation.single).to.equal(false);
  });

  it("sorts inside a subselect, since DISTINCT refuses an order term outside its select list", () => {
    const sql = Compile(Root().orderBy("age").distinct("name")).sql;
    expect(sql).to.match(/^SELECT DISTINCT `t1`\.`name` AS `value` FROM \(/);
    expect(sql).to.match(/ORDER BY `t0`\.`age` ASC\) AS `t1`$/);
  });

  it("counts the distinct rows by wrapping them, not by counting every row", () => {
    expect(Compile(Root().distinct("name").count()).sql).to.match(
      /^SELECT CAST\(COUNT\(\*\) AS DOUBLE\) AS `value` FROM \(SELECT DISTINCT /,
    );
  });
});
