import { expect } from "chai";

import { Bind, ident, int, join, lit, param, sql } from "../../statement";

describe("Bind", () => {
  it("turns every value into a `?` and an argument, in textual order", () => {
    const left = param("a");
    const right = param(2);
    const bound = Bind(sql`SELECT ${right}, ${left}`);
    expect(bound).to.deep.equal({ sql: "SELECT ?, ?", args: [2, "a"] });
  });

  it("gives a repeated fragment one argument per occurrence", () => {
    const guarded = sql`(${param("x")} IS NULL OR ${param("y")} = 1)`;
    const bound = Bind(sql`${guarded} AND ${param(3)} AND ${guarded}`);
    expect(bound.sql).to.equal(
      "(? IS NULL OR ? = 1) AND ? AND (? IS NULL OR ? = 1)",
    );
    expect(bound.args).to.deep.equal(["x", "y", 3, "x", "y"]);
  });

  it("leaves a `?` inside a literal as text, not as a placeholder", () => {
    const bound = Bind(sql`SELECT ${lit("a?b")}, ${param(null)}`);
    expect(bound).to.deep.equal({ sql: "SELECT 'a?b', ?", args: [null] });
  });
});

describe("ident", () => {
  it("quotes with backticks and doubles a backtick inside the name", () => {
    expect(Bind(ident("we`ird")).sql).to.equal("`we``ird`");
    expect(Bind(ident("my-schema.tbl")).sql).to.equal("`my-schema.tbl`");
  });

  it("refuses a NUL rather than truncating the statement", () => {
    expect(() => ident("a\0b")).to.throw(/NUL/);
  });

  it("accepts 64 characters and refuses 65, counting characters rather than bytes", () => {
    expect(Bind(ident("é".repeat(64))).sql).to.equal(`\`${"é".repeat(64)}\``);
    expect(() => ident("a".repeat(65))).to.throw(/65 characters/);
  });
});

describe("lit", () => {
  it("doubles single quotes", () => {
    expect(Bind(lit("o'brien")).sql).to.equal("'o''brien'");
  });

  it("escapes backslashes, which the pinned sql_mode reads as escapes", () => {
    expect(Bind(lit("a\\")).sql).to.equal("'a\\\\'");
    expect(Bind(lit("a\\'b")).sql).to.equal("'a\\\\''b'");
  });

  it("refuses a NUL", () => {
    expect(() => lit("a\0b")).to.throw(/NUL/);
  });
});

describe("int", () => {
  it("writes a safe integer and refuses anything else", () => {
    expect(Bind(sql`LIMIT ${int(1000)}`).sql).to.equal("LIMIT 1000");
    expect(() => int(1.5)).to.throw(/safe integer/);
    expect(() => int(Number.NaN)).to.throw(/safe integer/);
  });
});

describe("join", () => {
  it("separates fragments and keeps their values in order", () => {
    const bound = Bind(join([param(1), ident("c"), param(2)], sql`, `));
    expect(bound).to.deep.equal({ sql: "?, `c`, ?", args: [1, 2] });
  });

  it("joins nothing into empty text", () => {
    expect(Bind(join([], sql`, `))).to.deep.equal({ sql: "", args: [] });
  });
});
