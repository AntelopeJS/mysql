import { expect } from "chai";

import {
  ArrayOf,
  IsArray,
  IsJsonBacked,
  IsOpaque,
  JsonOf,
  KeyTypesOf,
  OPAQUE,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";

describe("SqlType", () => {
  it("treats only shapeless json as the bottom type", () => {
    expect(IsOpaque(OPAQUE)).to.equal(true);
    expect(IsOpaque(JsonOf({ a: TEXT }))).to.equal(false);
    expect(IsOpaque(TEXT)).to.equal(false);
  });

  it("separates a shape that is empty from one that is unknown", () => {
    expect(JsonOf(undefined)).to.equal(OPAQUE);
    expect(JsonOf({})).to.deep.equal({ kind: "json", keys: {} });
    expect(IsOpaque(JsonOf({}))).to.equal(false);
  });

  it("reads the members of a shaped json and nothing else", () => {
    expect(KeyTypesOf(JsonOf({ a: TEXT }))).to.deep.equal({ a: TEXT });
    expect(KeyTypesOf(OPAQUE)).to.equal(undefined);
    expect(KeyTypesOf(ArrayOf(TEXT))).to.equal(undefined);
    expect(KeyTypesOf(TEXT)).to.equal(undefined);
  });

  it("reports json-backed kinds", () => {
    expect(IsJsonBacked(ArrayOf(TEXT))).to.equal(true);
    expect(IsJsonBacked(OPAQUE)).to.equal(true);
    expect(IsJsonBacked(TIMESTAMP)).to.equal(false);
  });

  it("calls only a list an array, not a document", () => {
    expect(IsArray(ArrayOf(TEXT))).to.equal(true);
    expect(IsArray(OPAQUE)).to.equal(false);
    expect(IsArray(TEXT)).to.equal(false);
  });
});
