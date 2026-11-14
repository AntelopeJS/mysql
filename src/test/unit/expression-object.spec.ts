import { expect } from "chai";
import { ValueProxy } from "@antelopejs/interface-database";

import { Compile, Root } from "./pipeline-fixture";
import { CompiledAlone, Occurrences, Projected } from "./expression-fixture";
import {
  ArrayOf,
  FLOAT,
  JsonOf,
  OPAQUE,
  TEXT,
} from "../../implementations/database/types";

const META = "`t0`.`meta`";

describe("obj_merge", () => {
  it("merge one level deep by walking the keys of both sides, keeping a JSON null the right holds", () => {
    const sql = Projected(
      Compile(Root().map((doc) => doc.key("meta").merge({ owner: "x" }))),
    );
    expect(sql).to.include("JSON_OBJECTAGG(");
    expect(sql).to.include("JSON_TABLE(JSON_MERGE_PRESERVE(JSON_KEYS(");
    expect(sql).to.not.include("JSON_MERGE_PATCH");
  });

  it("answer NULL for a side that is not an object, with the guard outside the aggregate that would answer {}", () => {
    const sql = Projected(
      Compile(Root().map((doc) => doc.key("meta").merge({ owner: "x" }))),
    );
    expect(sql).to.match(
      /^\(SELECT CASE WHEN \(JSON_TYPE\(`t1`\.`l`\) IN \('OBJECT'.*?AND \(JSON_TYPE\(`t1`\.`r`\) IN \('OBJECT'.*? THEN \(SELECT COALESCE\(JSON_OBJECTAGG/,
    );
  });

  it("hold each operand once however many merges are chained, so the text grows linearly", () => {
    const merged = (depth: number) =>
      Projected(
        Compile(
          Root().map((doc) => {
            let value = doc.key("meta").merge({ a: 1 });
            for (let at = 1; at < depth; at++) {
              value = value.merge({ a: 1 });
            }
            return value;
          }),
        ),
      );
    for (const depth of [1, 2, 4, 8]) {
      expect(Occurrences(merged(depth), META), `${depth} merges`).to.equal(1);
    }
    expect(merged(8).length).to.be.lessThan(merged(1).length * 12);
  });

  it("name each merge's derived tables apart", () => {
    const sql = Projected(
      Compile(
        Root().map((doc) => doc.key("meta").merge({ a: 1 }).merge({ b: 2 })),
      ),
    );
    for (const alias of ["t1", "t1_k", "t2", "t2_k"]) {
      expect(sql, alias).to.include(`AS \`${alias}\``);
    }
  });

  it("merge the shapes, so a date surviving a merge is still a date", () => {
    const merged = CompiledAlone(
      ValueProxy.constant({ a: 1, b: "x" }).merge({ b: 2, c: true }),
    );
    expect(merged.type).to.deep.equal(
      JsonOf({ a: FLOAT, b: FLOAT, c: { kind: "bool" } }),
    );
  });

  it("fall to the bottom type when either shape is unknown", () => {
    const merged = CompiledAlone(
      ValueProxy.constant({ a: 1 }).merge(
        ValueProxy.constant({ b: 1 }).key("b"),
      ),
    );
    expect(merged.type).to.deep.equal(OPAQUE);
  });
});

describe("obj_keys and obj_values", () => {
  it("walk the keys of the object, in the order of its ordinal, behind an object guard", () => {
    const sql = Projected(Compile(Root().map((doc) => doc.key("meta").keys())));
    expect(sql).to.include("(CASE WHEN (JSON_TYPE(`t0`.`meta`) IN ('OBJECT'");
    expect(sql).to.include(`(SELECT ${META} AS \`source\`) AS \`t1_s\``);
    expect(sql).to.include("JSON_TABLE(JSON_KEYS(`t1_s`.`source`), '$[*]'");
    expect(sql).to.include("JSON_OBJECTAGG(LPAD(`t1`.`ord`, 20, '0'), ");
  });

  it("walk the member values of the same object in the server's own order, so the two line up", () => {
    const sql = Projected(
      Compile(Root().map((doc) => doc.key("meta").values())),
    );
    expect(sql).to.include(`(SELECT ${META} AS \`source\`) AS \`t1_s\``);
    expect(sql).to.include("JSON_TABLE(`t1_s`.`source`, '$.*'");
    expect(sql).to.not.include("JSON_KEYS");
  });

  it("type the keys as text and the values as unknown", () => {
    const object = ValueProxy.constant({ a: 1 });
    expect(CompiledAlone(object.keys()).type).to.deep.equal(ArrayOf(TEXT));
    expect(CompiledAlone(object.values()).type).to.deep.equal(ArrayOf(OPAQUE));
  });

  it("give two walks in one expression aliases of their own", () => {
    const sql = Projected(
      Compile(
        Root().map((doc) => ({
          keys: doc.key("meta").keys(),
          values: doc.key("meta").values(),
        })),
      ),
    );
    expect(sql).to.include("AS `t1`");
    expect(sql).to.include("AS `t2`");
  });
});

describe("obj_has", () => {
  it("test each field with JSON_CONTAINS_PATH, and require every one", () => {
    const sql = Projected(
      Compile(Root().map((doc) => doc.key("meta").hasfields("title", "owner"))),
    );
    expect(sql).to.equal(
      `(JSON_CONTAINS_PATH(${META}, 'one', '$."title"') AND JSON_CONTAINS_PATH(${META}, 'one', '$."owner"'))`,
    );
  });

  it("quote a field name, so a quote in it is part of the name", () => {
    const sql = Projected(
      Compile(Root().map((doc) => doc.key("meta").hasfields('a"b'))),
    );
    expect(sql).to.include('\'$."a\\\\"b"\'');
  });

  it("read an empty list as an object test, true of an object and false of anything else", () => {
    const sql = Projected(
      Compile(Root().map((doc) => doc.key("meta").hasfields())),
    );
    expect(sql).to.equal(
      `(JSON_TYPE(${META}) IN ('OBJECT' COLLATE utf8mb4_bin))`,
    );
  });
});
