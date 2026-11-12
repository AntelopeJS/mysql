import { expect } from "chai";

import { Compile, Root } from "./pipeline-fixture";
import { Projected } from "./expression-fixture";

const NAME = "`t0`.`name`";
const NICKNAME_TEXT =
  "(CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`_extra`, '$.\"nickname\"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t0`.`_extra`, '$.\"nickname\"')) AS CHAR) END)";

describe("The string stages", () => {
  it("map the case stages onto UPPER and LOWER of the column", () => {
    expect(
      Projected(Compile(Root().map((doc) => doc.key("name").upcase()))),
    ).to.equal(`UPPER(${NAME})`);
    expect(
      Projected(Compile(Root().map((doc) => doc.key("name").downcase()))),
    ).to.equal(`LOWER(${NAME})`);
  });

  it("read an undeclared key through the string guard, so a stored number is NULL and not its digits", () => {
    const bound = Compile(Root().map((doc) => doc.key("nickname").upcase()));
    expect(Projected(bound)).to.equal(`UPPER(${NICKNAME_TEXT})`);
  });

  it("count codepoints with CHAR_LENGTH and hand the driver a DOUBLE", () => {
    const bound = Compile(Root().map((doc) => doc.key("name").strlen()));
    expect(Projected(bound)).to.equal(`CAST(CHAR_LENGTH(${NAME}) AS DOUBLE)`);
  });

  it("concatenate with CONCAT and bind the other operand, never spelling MySQL's OR", () => {
    const bound = Compile(Root().map((doc) => doc.key("name").concat(" x")));
    expect(Projected(bound)).to.equal(`CONCAT(${NAME}, ?)`);
    expect(bound.args).to.deep.equal([" x", ""]);
    expect(bound.sql).to.not.include("||");
  });

  it("match a literal pattern after translating it for the engine, and bind it", () => {
    const bound = Compile(Root().map((doc) => doc.key("name").match("^a.b$")));
    expect(Projected(bound)).to.equal(`REGEXP_LIKE(${NAME}, ?, 'c')`);
    expect(bound.args[0]).to.equal("^a[^\\n\\r\\x{2028}\\x{2029}]b\\z");
  });

  it("bind a pattern the statement computes as it is, without translating it", () => {
    const bound = Compile(
      Root().map((doc) => doc.key("name").match(doc.key("nickname"))),
    );
    expect(Projected(bound)).to.equal(
      `REGEXP_LIKE(${NAME}, ${NICKNAME_TEXT}, 'c')`,
    );
    expect(bound.args).to.deep.equal([""]);
  });

  it("split with the separator bound where it is compared and the text held once", () => {
    const bound = Compile(Root().map((doc) => doc.key("name").split(",")));
    const sql = Projected(bound);
    expect(sql).to.include("FROM (SELECT `t0`.`name` AS `t`) AS `t1`");
    expect(bound.args).to.deep.equal([",", ",", ",", ""]);
    expect(sql).to.not.include("WHERE `t1_p`");
  });

  it("split on a space when no separator is given", () => {
    const bound = Compile(Root().map((doc) => doc.key("name").split()));
    expect(bound.args.slice(0, 3)).to.deep.equal([" ", " ", " "]);
  });

  it("read a split bound as no bound for NaN, as none for a negative, and as every piece for Infinity", () => {
    const limited = (maxSplits: number) =>
      Projected(
        Compile(Root().map((doc) => doc.key("name").split(",", maxSplits))),
      );
    expect(limited(Number.NaN)).to.not.include("`t1_p`.`ord` <=");
    expect(limited(-3)).to.include("`t1_p`.`ord` <= 0");
    expect(limited(2.9)).to.include("`t1_p`.`ord` <= 2");
    expect(limited(Number.POSITIVE_INFINITY)).to.include(
      "`t1_p`.`ord` <= 2147483647",
    );
  });
});
