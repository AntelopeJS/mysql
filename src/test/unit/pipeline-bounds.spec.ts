import { expect } from "chai";

import {
  Compile,
  CompiledRelation,
  EntriesRoot,
  Other,
  Root,
} from "./pipeline-fixture";

const PRODUCT_COUNT =
  /LEAST\(GREATEST\(TRUNCATE\(\(SELECT CAST\(COUNT\(\*\) AS DOUBLE\)/;

describe("a row bound", () => {
  it("binds a constant as LIMIT and OFFSET, numbering no row", () => {
    const bound = Compile(Root().orderBy("age").slice(1, 2));
    expect(bound.sql).to.match(/ORDER BY `t0`\.`age` ASC LIMIT \? OFFSET \?$/);
    expect(bound.sql).to.not.include("ROW_NUMBER");
    expect(bound.args).to.deep.equal(["", 2, 1]);
  });

  it("numbers the rows in their own order for a count the statement computes, and keeps the range", () => {
    const sql = Compile(Root().orderBy("age").slice(1, Other().count())).sql;
    expect(sql).to.include(
      "ROW_NUMBER() OVER (ORDER BY `t0`.`age` ASC) AS `_row` FROM `directory__people` AS `t0`",
    );
    expect(sql).to.match(
      /WHERE \(`t2`\.`_row` > COALESCE\(CAST\(\? AS DOUBLE\), 0\) AND \(/,
    );
    expect(sql).to.match(
      / OR `t2`\.`_row` <= COALESCE\(CAST\(\? AS DOUBLE\), 0\) \+ LEAST/,
    );
    expect(sql).to.match(PRODUCT_COUNT);
    expect(sql).to.match(/ORDER BY `t2`\.`_row` ASC$/);
  });

  it("compares the numbers with the outer row's own column in a correlated subquery", () => {
    const sql = Compile(
      Root().map((person) => ({
        cheapest: Other()
          .orderBy("price")
          .slice(0, person.key("age"))
          .map((product) => product.key("name")),
      })),
    ).sql;
    expect(sql).to.include(
      "`t2`.`_row` <= COALESCE(CAST(? AS DOUBLE), 0) + LEAST(GREATEST(TRUNCATE(`t0`.`age`, 0), 0), 9007199254740991)",
    );
    expect(sql).to.include(
      "ROW_NUMBER() OVER (ORDER BY `t2`.`_row` ASC) AS `_row`",
    );
    expect(sql).to.include("JSON_OBJECTAGG(LPAD(`t3`.`_row`, 20, '0'), ");
  });

  it("takes one numbered row for an nth the statement computes, and answers it as a single row", () => {
    const query = Root().orderBy("age").nth(Other().count());
    expect(CompiledRelation(query).single).to.equal(true);
    expect(Compile(query).sql).to.match(/`t2`\.`_row` <= COALESCE\(LEAST\(/);
  });

  it("dedups before numbering, since numbered rows are all distinct", () => {
    expect(
      Compile(Root().distinct("name").slice(0, Other().count())).sql,
    ).to.include(
      "ROW_NUMBER() OVER () AS `_row` FROM (SELECT DISTINCT `t0`.`name` AS `value`",
    );
  });

  it("names the row numbers apart from a declared field that takes their name", () => {
    const sql = Compile(EntriesRoot().slice(0, Other().count())).sql;
    expect(sql).to.include(
      "`t0`.`_row`, `t0`.`_extra`, ROW_NUMBER() OVER () AS `__row`",
    );
  });
});
