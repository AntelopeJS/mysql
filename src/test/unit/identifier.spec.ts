import { expect } from "chai";

import {
  CrossInstanceIndexName,
  IndexName,
  KeyColumnName,
  MysqlIdentifier,
  TableName,
} from "../../implementations/database/identifier";

const LONG = "a".repeat(100);

describe("MysqlIdentifier", () => {
  it("passes a name that fits through untouched", () => {
    expect(MysqlIdentifier("orders")).to.equal("orders");
    expect(MysqlIdentifier("a".repeat(64))).to.equal("a".repeat(64));
  });

  it("cuts a name that does not fit to 55 characters and a digest", () => {
    const out = MysqlIdentifier(LONG);
    expect(out).to.have.length(64);
    expect(out.slice(0, 55)).to.equal("a".repeat(55));
    expect(out.slice(55)).to.match(/^_[0-9a-f]{8}$/);
  });

  it("is deterministic and distinguishes near-identical names", () => {
    expect(MysqlIdentifier(LONG)).to.equal(MysqlIdentifier(LONG));
    expect(MysqlIdentifier(LONG)).to.not.equal(MysqlIdentifier(`${LONG}b`));
  });

  it("counts characters, as MySQL does, not bytes", () => {
    expect(MysqlIdentifier("é".repeat(64))).to.equal("é".repeat(64));
    expect(Array.from(MysqlIdentifier("é".repeat(65)))).to.have.length(64);
  });
});

describe("generated names", () => {
  it("joins the prefix, the schema id and the table id into the table name", () => {
    expect(TableName("app_", "shop", "orders")).to.equal("app_shop__orders");
    expect(TableName("", "shop", "orders")).to.equal("shop__orders");
    expect(TableName("", LONG, "orders")).to.have.length(64);
  });

  it("names an index after its id, since index names are per table", () => {
    expect(IndexName("customerId")).to.equal("customerId");
    expect(CrossInstanceIndexName("customerId")).to.equal("customerId__g");
  });

  it("moves an index id off the name only the primary key may use", () => {
    expect(IndexName("primary")).to.match(/^primary_[0-9a-f]{8}$/);
    expect(IndexName("PRIMARY")).to.match(/^PRIMARY_[0-9a-f]{8}$/);
    expect(IndexName("primary")).to.not.equal(IndexName("PRIMARY"));
  });

  it("names a key column readably, within the limit, and apart for each definition", () => {
    const name = KeyColumnName(["title", "fr"], "definition-1");
    expect(name).to.match(/^__k_title_fr_[0-9a-f]{8}$/);
    expect(KeyColumnName(["title", "fr"], "definition-2")).to.not.equal(name);
    expect(KeyColumnName([LONG, "x.y"], "d")).to.have.length(64);
    expect(KeyColumnName(["a b", "c`d"], "d")).to.match(/^__k_a_b_c_d_/);
  });
});
