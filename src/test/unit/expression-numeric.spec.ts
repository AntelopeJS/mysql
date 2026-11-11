import { expect } from "chai";

import { Compile, ProfilesRoot, Root } from "./pipeline-fixture";
import { Occurrences, Projected } from "./expression-fixture";

const AGE = "`t0`.`age`";
const INT32_AGE = `CAST(MOD(MOD(TRUNCATE(${AGE}, 0), 4294967296) + 6442450944, 4294967296) - 2147483648 AS SIGNED)`;

describe("The arithmetic stages", () => {
  it("add two numbers with a bound DOUBLE, without reading the row as a document", () => {
    const bound = Compile(Root().map((doc) => doc.key("age").add(1)));
    expect(Projected(bound)).to.equal(`(${AGE} + CAST(? AS DOUBLE))`);
  });

  it("read a number added to a date as seconds, through epoch milliseconds and the range of an instant", () => {
    const sql = Projected(
      Compile(Root().map((doc) => doc.key("joined").add(5))),
    );
    expect(sql).to.include("TIMESTAMPADD(MICROSECOND");
    expect(sql).to.include("BETWEEN -30610224000000 AND 253402300799999");
    expect(sql).to.include("+ CAST(? AS DOUBLE) * 1000");
  });

  it("read a number taken from a date as seconds taken, and two dates as the seconds between them", () => {
    const taken = Projected(
      Compile(Root().map((doc) => doc.key("joined").sub(5))),
    );
    expect(taken).to.include("- CAST(? AS DOUBLE) * 1000");
    const between = Projected(
      Compile(Root().map((doc) => doc.key("joined").sub(new Date(0)))),
    );
    expect(Occurrences(between, "TIMESTAMPDIFF(MICROSECOND")).to.equal(2);
    expect(between).to.include("/ 1000");
  });

  it("concatenate two strings with CONCAT", () => {
    const bound = Compile(Root().map((doc) => doc.key("name").add("!")));
    expect(Projected(bound)).to.equal("CONCAT(`t0`.`name`, ?)");
  });

  it("concatenate two lists, answering NULL for a JSON null operand", () => {
    const sql = Projected(
      Compile(ProfilesRoot().map((doc) => doc.key("skills").add(["x"]))),
    );
    expect(sql).to.include("JSON_MERGE_PRESERVE(");
    expect(sql).to.include("NULLIF(");
    expect(sql).to.include("CAST('null' AS JSON))");
  });

  it("read a zero divisor as absent, for division and modulo alike, and leave the dividend a bare column", () => {
    expect(
      Projected(
        Compile(Root().map((doc) => doc.key("age").div(doc.key("age")))),
      ),
    ).to.equal(`(${AGE} / NULLIF(${AGE}, 0))`);
    expect(
      Projected(Compile(Root().map((doc) => doc.key("age").mod(3)))),
    ).to.equal(`CAST(MOD(${AGE}, NULLIF(CAST(? AS DOUBLE), 0)) AS DOUBLE)`);
  });

  it("multiply with the plain infix operator", () => {
    const bound = Compile(Root().map((doc) => doc.key("age").mul(2)));
    expect(Projected(bound)).to.equal(`(${AGE} * CAST(? AS DOUBLE))`);
  });

  it("round half up as FLOOR(x + 0.5), and ceil and floor through their functions", () => {
    expect(
      Projected(Compile(Root().map((doc) => doc.key("age").round()))),
    ).to.equal(`CAST(FLOOR(${AGE} + 0.5) AS DOUBLE)`);
    expect(
      Projected(Compile(Root().map((doc) => doc.key("age").ceil()))),
    ).to.equal(`CAST(CEIL(${AGE}) AS DOUBLE)`);
    expect(
      Projected(Compile(Root().map((doc) => doc.key("age").floor()))),
    ).to.equal(`CAST(FLOOR(${AGE}) AS DOUBLE)`);
  });
});

describe("The bitwise stages", () => {
  it("read each operand as ToInt32 with a remainder, never through a bigint cast, and mask a result to 32 bits", () => {
    const sql = Projected(Compile(Root().map((doc) => doc.key("age").band(3))));
    expect(sql).to.include(INT32_AGE);
    expect(sql).to.include("& 4294967295) + 2147483648) MOD 4294967296");
    expect(sql).to.not.match(/NaN|Infinity/);
  });

  it("spell each operator the engine does, with XOR as ^", () => {
    const operator = (sql: string) => sql.match(/AS SIGNED\) (\S+) CAST/)?.[1];
    expect(
      operator(Projected(Compile(Root().map((doc) => doc.key("age").bor(1))))),
    ).to.equal("|");
    expect(
      operator(Projected(Compile(Root().map((doc) => doc.key("age").bxor(1))))),
    ).to.equal("^");
  });

  it("complement through ~ and a mask, and mask a shift count to five bits", () => {
    expect(
      Projected(Compile(Root().map((doc) => doc.key("age").bnot()))),
    ).to.include(`~(${INT32_AGE})`);
    expect(
      Projected(Compile(Root().map((doc) => doc.key("age").blshift(33)))),
    ).to.include("& 31)");
  });

  it("shift right with zeros unless the caller asked for the sign", () => {
    const logical = Projected(
      Compile(Root().map((doc) => doc.key("age").brshift(1))),
    );
    expect(logical).to.include(`(${INT32_AGE} & 4294967295) >> (`);
    const signed = Projected(
      Compile(Root().map((doc) => doc.key("age").brshiftPreserveSign(1))),
    );
    expect(signed).to.include(`${INT32_AGE} >> (`);
    expect(signed).to.not.include(`(${INT32_AGE} & 4294967295) >>`);
  });
});
