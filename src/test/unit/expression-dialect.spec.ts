import { expect } from "chai";

import { DIALECTS } from "../../dialect";
import { Bind, param, sql } from "../../statement";

const { json, scalar, time } = DIALECTS.mysql.sql;

describe("The MySQL regular expression translation", () => {
  const translate = (pattern: string) => scalar.regex.translate(pattern);

  it("rewrites . outside a class into JavaScript's four line terminators, and leaves it inside one", () => {
    expect(translate("a.b")).to.equal("a[^\\n\\r\\u2028\\u2029]b");
    expect(translate("[.]")).to.equal("[.]");
    expect(translate("a\\.b")).to.equal("a\\.b");
  });

  it("rewrites $ into the end of the input, which JavaScript's alone is", () => {
    expect(translate("c$")).to.equal("c\\z");
    expect(translate("[$]")).to.equal("[$]");
    expect(translate("\\$")).to.equal("\\$");
  });

  it("escapes what ICU reads as a nested set or an intersection inside a class", () => {
    expect(translate("[[]")).to.equal("[\\[]");
    expect(translate("[a&&b]")).to.equal("[a\\&\\&b]");
  });

  it("leaves a named group and a back reference, which ICU reads as JavaScript does", () => {
    expect(translate("(?<x>a)\\1")).to.equal("(?<x>a)\\1");
  });

  it("ends a class at its closing bracket, so what follows is outside it", () => {
    expect(translate("[a].")).to.equal("[a][^\\n\\r\\u2028\\u2029]");
  });

  it("escapes a hyphen beside a set escape in a class, which would otherwise bound a range with the escape's first or last member", () => {
    expect(translate("[\\d-.]")).to.equal("[0-9\\-.]");
    expect(translate("[.-\\d]")).to.equal("[.\\-0-9]");
    expect(translate("[\\d-\\d]")).to.equal("[0-9\\-0-9]");
    expect(translate("[a-z]")).to.equal("[a-z]");
    expect(translate("[\\b-z]")).to.equal("[\\x{08}-z]");
  });

  it("leaves the member after a set escape's hyphen free of the next hyphen, and escapes every hyphen that is no range", () => {
    expect(translate("[\\d-a-f]")).to.equal("[0-9\\-a\\-f]");
    expect(translate("[.-\\w-a-c]")).to.equal("[.\\-A-Za-z0-9_\\-a-c]");
    expect(translate("[--e]")).to.equal("[\\--e]");
    expect(translate("[a-]")).to.equal("[a\\-]");
    expect(translate("[\\x41-\\x5A-]")).to.equal("[\\x41-\\x5A\\-]");
  });
});

describe("The MySQL int32 members", () => {
  it("spell the operand once, however long it is", () => {
    const bound = Bind(scalar.int32.read(param(1.5)));
    expect(bound.args).to.deep.equal([1.5]);
  });

  it("wrap a result to 32 bits and restore its sign, since the operators work on 64 unsigned bits", () => {
    const text = Bind(scalar.int32.and(sql`a`, sql`b`)).sql;
    expect(text).to.equal(
      "(CAST((((a & b) & 4294967295) + 2147483648) MOD 4294967296 AS SIGNED) - 2147483648)",
    );
  });

  it("leave an unsigned right shift unsigned, with no sign to restore", () => {
    const text = Bind(scalar.int32.shiftRightUnsigned(sql`a`, sql`n`)).sql;
    expect(text).to.equal("((a & 4294967295) >> (n & 31))");
  });
});

describe("The MySQL JSON walk", () => {
  it("name the rows of a list walk and read an object's keys through JSON_KEYS", () => {
    const elements = json.walk("elements", sql`doc`, "w");
    expect(Bind(elements.aggregate(elements.ordinal)).sql).to.equal(
      "(SELECT `w`.`ord` FROM JSON_TABLE(doc, '$[*]' COLUMNS (`ord` FOR ORDINALITY, `value` JSON PATH '$')) AS `w`)",
    );
    const keys = json.walk("keys", sql`doc`, "w");
    expect(Bind(keys.aggregate(keys.value, sql`1`)).sql).to.include(
      "JSON_TABLE(JSON_KEYS(doc), '$[*]'",
    );
  });

  it("split an empty separator into the whole text, with no cutting", () => {
    const text = Bind(json.split(sql`doc`, "", undefined, "s")).sql;
    expect(text).to.not.include("SUBSTRING_INDEX");
    expect(text).to.not.include("REPLACE(");
  });

  it("count a multi-character separator by its characters, not its bytes", () => {
    const text = Bind(json.split(sql`doc`, "é-é", undefined, "s")).sql;
    expect(text).to.include("DIV 3)");
  });
});

describe("The MySQL date members", () => {
  it("read the seconds and microseconds together, spelling the instant once", () => {
    const bound = Bind(time.part(param("2023-01-15"), "second"));
    expect(bound.args).to.have.length(1);
  });
});
