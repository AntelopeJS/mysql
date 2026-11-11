import { expect } from "chai";
import { ValueProxy } from "@antelopejs/interface-database";
import type { QueryValue } from "@antelopejs/interface-database/common";

import { DIALECTS } from "../../dialect";
import { Bind, sql } from "../../statement";
import {
  Cast,
  Unify,
  UnifyAll,
  Widen,
} from "../../implementations/database/coerce";
import { ClassifyMember } from "../../implementations/database/member";
import {
  ArrayOf,
  BOOL,
  FLOAT,
  JsonOf,
  OPAQUE,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";

const dialect = DIALECTS.mysql;

/** An instance of a class, which holds keys as a document does but is not an object literal. */
class Instance {
  [field: string]: QueryValue;
}

describe("Type unification", () => {
  it("pulls the bottom type toward the concrete operand", () => {
    expect(Unify(OPAQUE, TEXT)).to.equal(TEXT);
    expect(Unify(FLOAT, OPAQUE)).to.equal(FLOAT);
  });

  it("meets two different scalars at the bottom type", () => {
    expect(Unify(TEXT, FLOAT)).to.deep.equal(OPAQUE);
  });

  it("intersects two shapes for one operator, and unions them for alternative rows", () => {
    const left = JsonOf({ a: TEXT, b: FLOAT });
    const right = JsonOf({ b: FLOAT, c: BOOL });
    expect(Unify(left, right)).to.deep.equal(JsonOf({ b: FLOAT }));
    expect(Widen(left, right)).to.deep.equal(
      JsonOf({ a: TEXT, b: FLOAT, c: BOOL }),
    );
  });

  it("keeps the bottom type absorbing over a collection, however many types it folds", () => {
    expect(UnifyAll([TEXT, OPAQUE, TEXT])).to.deep.equal(OPAQUE);
    expect(UnifyAll([])).to.deep.equal(OPAQUE);
  });
});

describe("A cast", () => {
  it("reads a JSON value as text only where it holds a string, in the session collation", () => {
    const cast = Cast(dialect, { sql: sql`v`, type: OPAQUE }, TEXT);
    expect(Bind(cast.sql).sql).to.equal(
      "(CASE WHEN (JSON_TYPE(v) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(v) AS CHAR) END)",
    );
  });

  it("writes a boolean as a JSON boolean, which a stored TINYINT is not on its own", () => {
    const cast = Cast(dialect, { sql: sql`b`, type: BOOL }, OPAQUE);
    expect(Bind(cast.sql).sql).to.equal("CAST((b) <> 0 AS JSON)");
  });

  it("writes an instant as the ISO text JavaScript spells", () => {
    const cast = Cast(dialect, { sql: sql`t`, type: TIMESTAMP }, OPAQUE);
    expect(Bind(cast.sql).sql).to.equal(
      "CAST(JSON_QUOTE(CONCAT(LEFT(DATE_FORMAT(t, '%Y-%m-%dT%H:%i:%s.%f'), 23), 'Z')) AS JSON)",
    );
  });

  it("is the identity between two JSON-backed types, keeping what the value reads", () => {
    const value = { sql: sql`v`, type: ArrayOf(TEXT) };
    expect(Cast(dialect, value, OPAQUE).sql).to.equal(value.sql);
  });
});

describe("A caller value", () => {
  it("is classified by what it is, a proxy before an object", () => {
    expect(ClassifyMember(ValueProxy.constant(1)).kind).to.equal("proxy");
    expect(ClassifyMember(new Date(0)).kind).to.equal("date");
    expect(ClassifyMember({ a: 1 }).kind).to.equal("record");
    expect(ClassifyMember(undefined).kind).to.equal("absent");
  });

  it("offers a list whole only when every item is JSON the driver can send", () => {
    const constant = ClassifyMember(["a", 1, null, { b: [true] }]);
    expect(constant.kind === "list" && constant.constant()).to.deep.equal([
      "a",
      1,
      null,
      { b: [true] },
    ]);
    const computed = ClassifyMember(["a", ValueProxy.constant(1)]);
    expect(computed.kind === "list" && computed.constant()).to.equal(undefined);
  });

  it("refuses an instance of something that is not a document in a query", () => {
    const opaque = ClassifyMember(new Instance());
    expect(opaque.kind).to.equal("opaque");
    expect(() => opaque.refuseInQuery()).to.throw(/kind 'opaque'/);
  });

  it("reads a document's own keys when the walk asks, and no inherited one", () => {
    const document = ClassifyMember({ a: 1 }).document;
    expect(document?.own("a")?.kind).to.equal("number");
    expect(document?.own("toString")).to.equal(undefined);
  });
});
