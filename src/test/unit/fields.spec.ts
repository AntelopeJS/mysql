import { expect } from "chai";
import type {
  FieldType,
  TableDefinition,
} from "@antelopejs/interface-database/schema";

import { type ForeignValue, WithForeign } from "./spec-fixture";
import { MysqlIdentifier } from "../../implementations/database/identifier";
import {
  DocumentKeys,
  ParseFieldType,
  ParseTable,
  PhysicalOrder,
} from "../../implementations/database/fields";
import {
  ArrayOf,
  FLOAT,
  JsonOf,
  OPAQUE,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";

function Declaring(field: string, declared: ForeignValue): TableDefinition {
  return { fields: WithForeign({}, field, declared), indexes: {} };
}

describe("ParseFieldType", () => {
  it("accepts the token set case-insensitively", () => {
    expect(ParseFieldType("string", "t.f").type).to.equal(TEXT);
    expect(ParseFieldType("Date", "t.f").type).to.equal(TIMESTAMP);
    expect(ParseFieldType("date", "t.f").type).to.equal(TIMESTAMP);
    expect(ParseFieldType("number", "t.f").type).to.equal(FLOAT);
    expect(ParseFieldType("object", "t.f").type).to.equal(OPAQUE);
  });

  it("accepts both array spellings", () => {
    expect(ParseFieldType("string[]", "t.f").type).to.deep.equal(ArrayOf(TEXT));
    expect(ParseFieldType(["string"], "t.f").type).to.deep.equal(ArrayOf(TEXT));
    expect(ParseFieldType("object[]", "t.f").type).to.deep.equal(
      ArrayOf(OPAQUE),
    );
  });

  it("parses a nested record into a shape", () => {
    const parsed = ParseFieldType(
      { level: "number", tags: "string[]" },
      "t.metadata",
    );
    expect(parsed.type).to.deep.equal(
      JsonOf({ level: FLOAT, tags: ArrayOf(TEXT) }),
    );
  });

  it("detects an io-ts codec structurally", () => {
    const codec = {
      _A: undefined,
      _O: undefined,
      _I: undefined,
      name: "X",
      is: () => true,
      encode: (v) => v,
      decode: () => ({ _tag: "Right" }),
    } satisfies Extract<FieldType, { is: unknown }>;
    const parsed = ParseFieldType(codec, "t.status");
    expect(parsed.type).to.equal(OPAQUE);
    expect(parsed.codec).to.equal(codec);
  });

  it("rejects an unknown token, naming the field", () => {
    expect(() => ParseFieldType("uuid", "shop.orders.ref")).to.throw(
      /shop\.orders\.ref/,
    );
    expect(() => ParseFieldType("uuid", "shop.orders.ref")).to.throw(/uuid/);
  });

  it("rejects tokens inherited from Object.prototype", () => {
    for (const token of ["constructor", "__proto__", "valueOf"]) {
      expect(() => ParseFieldType(token, "t.f")).to.throw(
        /Unsupported field type/,
      );
    }
  });

  it("rejects a declaration that is neither a string, array nor object", () => {
    for (const declared of [null, 123, true]) {
      expect(() =>
        ParseTable(Declaring("f", declared), "shop.orders"),
      ).to.throw(/Unsupported field type/);
    }
  });
});

describe("ParseTable", () => {
  it("rejects the reserved columns a schema may not declare", () => {
    expect(() =>
      ParseTable(
        { fields: { _instance: "string" }, indexes: {} },
        "shop.orders",
      ),
    ).to.throw(/_instance/);
    expect(() =>
      ParseTable({ fields: { _extra: "string" }, indexes: {} }, "shop.orders"),
    ).to.throw(/_extra/);
  });

  it("rejects a reserved column spelled in another case, which MySQL reads as the same column", () => {
    for (const name of ["_Instance", "_EXTRA", "_Id"]) {
      expect(() =>
        ParseTable({ fields: { [name]: "string" }, indexes: {} }, "s.t"),
      ).to.throw(/reserved column name/);
    }
  });

  it("accepts a declared key column, which restates it rather than adding one", () => {
    const model = ParseTable(
      { fields: { _id: "string", price: "number" }, indexes: {} },
      "shop.orders",
    );
    expect(Object.keys(model.fields)).to.deep.equal(["price"]);
    expect(DocumentKeys(model)).to.deep.equal(["_id", "_instance", "price"]);
  });

  it("refuses a declared key column the key could not be", () => {
    expect(() =>
      ParseTable({ fields: { _id: "number" }, indexes: {} }, "shop.orders"),
    ).to.throw(
      "Field '_id' on 'shop.orders' restates the adapter's key column and must be declared 'string'",
    );
  });

  it("fits an oversized field name into a column name", () => {
    const name = "n".repeat(100);
    const model = ParseTable(
      { fields: { name: "string" }, indexes: {} },
      "shop.orders",
    );
    expect(model.fields.name.column).to.equal("name");

    const long = ParseTable(
      { fields: { [name]: "string" }, indexes: {} },
      "shop.orders",
    );
    expect(long.fields[name].column).to.equal(MysqlIdentifier(name));
    expect(long.fields[name].column).to.not.equal(name);
  });

  it("rejects two fields that collide on one column", () => {
    const name = "c".repeat(100);
    expect(() =>
      ParseTable(
        {
          fields: { [name]: "string", [MysqlIdentifier(name)]: "string" },
          indexes: {},
        },
        "shop.orders",
      ),
    ).to.throw(/both map to column/);
  });

  it("rejects two fields that differ only in case, which MySQL reads as one column", () => {
    expect(() =>
      ParseTable(
        { fields: { price: "number", Price: "number" }, indexes: {} },
        "shop.orders",
      ),
    ).to.throw(/'price' and 'Price' on 'shop.orders' both map to column/);
  });
});

describe("PhysicalOrder", () => {
  it("puts the key and the instance first and the overflow last", () => {
    expect(PhysicalOrder("k", "i", ["a", "b"], "x")).to.deep.equal([
      "k",
      "i",
      "a",
      "b",
      "x",
    ]);
  });
});
