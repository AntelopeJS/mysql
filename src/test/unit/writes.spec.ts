import { expect } from "chai";
import { DuplicateKeyError } from "@antelopejs/interface-database";

import { WithForeign } from "./spec-fixture";
import {
  CrossInstanceRoot,
  LogsRoot,
  Root,
  Written,
  WrittenStatements,
} from "./pipeline-fixture";

const SELECTED_ROW =
  "SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`name`, `t0`.`age`, `t0`.`isActive`, `t0`.`joined`, `t0`.`meta`, `t0`.`_extra` FROM `directory__people` AS `t0` WHERE (`t0`.`_instance` = ?) AND (`t0`.`_id` = ?)";

/** The derived read an identity write joins, at the alias the counter hands it after the root's. */
function Joined(read: string): string {
  return `UPDATE /*+ NO_MERGE(\`t1\`) */ \`directory__people\` AS \`w0\` JOIN (${read} FOR UPDATE) AS \`t1\` ON \`w0\`.\`_instance\` = \`t1\`.\`_instance\` AND \`w0\`.\`_id\` = \`t1\`.\`_id\``;
}

describe("An insert", () => {
  it("writes the batch in one statement naming the columns some row writes, and answers its keys", () => {
    const statement = Written(
      Root().insert([
        { _id: "a", name: "Ann" },
        { _id: "b", nickname: "B" },
      ]),
    );
    expect(statement).to.include({ kind: "insert" });
    expect(statement.kind === "insert" && statement.ids).to.deep.equal([
      "a",
      "b",
    ]);
    expect(WrittenStatements(statement)).to.deep.equal([
      {
        sql: "INSERT INTO `directory__people` (`_id`, `_instance`, `name`, `_extra`) VALUES (?, ?, ?, JSON_OBJECT()), (?, ?, NULL, JSON_OBJECT('nickname', CAST(JSON_QUOTE(?) AS JSON)))",
        args: ["a", "", "Ann", "b", "", "B"],
      },
    ]);
  });

  it("generates a key for a document that supplies none, and binds the one it answers", () => {
    const statement = Written(Root().insert({ name: "Ann" }));
    const ids = statement.kind === "insert" ? statement.ids : [];
    expect(ids).to.have.length(1);
    expect(WrittenStatements(statement)[0].args[0]).to.equal(ids[0]);
  });

  it("runs nothing for an empty batch", () => {
    expect(Written(Root().insert([]))).to.deep.equal({
      kind: "insert",
      ids: [],
      statements: [],
      sets: [],
    });
  });

  it("refuses to write under CROSS_INSTANCE, which names no instance to write into", () => {
    expect(() => Written(CrossInstanceRoot().insert({ name: "Ann" }))).to.throw(
      /cannot write under CROSS_INSTANCE/,
    );
  });

  it("refuses a payload writing a column the adapter owns", () => {
    expect(() => Written(LogsRoot().insert({ _extra: 1 }))).to.throw(
      /Payload key '_extra'/,
    );
  });
});

describe("An insert with a conflict mode", () => {
  it("locks the keys, merges into the rows that exist and inserts the rest, never through ON DUPLICATE KEY", () => {
    const statement = Written(
      Root().insert([{ _id: "a", age: 3, nickname: "A" }, { _id: "b" }], {
        conflict: "update",
      }),
    );
    const statements = WrittenStatements(statement, ["a"]);
    expect(statements).to.deep.equal([
      {
        sql: "SELECT `w0`.`_id` AS `_id` FROM `directory__people` AS `w0` WHERE `w0`.`_instance` = ? AND `w0`.`_id` IN (?, ?) FOR UPDATE",
        args: ["", "a", "b"],
      },
      {
        sql: "UPDATE `directory__people` AS `w0` SET `w0`.`age` = CAST(? AS DOUBLE), `w0`.`_extra` = JSON_SET(COALESCE(`w0`.`_extra`, JSON_OBJECT()), '$.\"nickname\"', CAST(JSON_QUOTE(?) AS JSON)) WHERE `w0`.`_instance` = ? AND `w0`.`_id` = ?",
        args: [3, "A", "", "a"],
      },
      {
        sql: "INSERT INTO `directory__people` (`_id`, `_instance`, `_extra`) VALUES (?, ?, JSON_OBJECT())",
        args: ["b", ""],
      },
    ]);
    expect(statements.map((one) => one.sql).join(" ")).to.not.include(
      "DUPLICATE",
    );
  });

  it("states every declared column of a row it replaces, NULL where the document is silent", () => {
    const statements = WrittenStatements(
      Written(
        Root().insert([{ _id: "a", name: "A" }], { conflict: "replace" }),
      ),
      ["a"],
    );
    expect(statements[1].sql).to.equal(
      "UPDATE `directory__people` AS `w0` SET `w0`.`name` = ?, `w0`.`age` = NULL, `w0`.`isActive` = NULL, `w0`.`joined` = NULL, `w0`.`meta` = NULL, `w0`.`_extra` = JSON_OBJECT() WHERE `w0`.`_instance` = ? AND `w0`.`_id` = ?",
    );
  });

  it("refuses a batch naming one key twice before anything runs", () => {
    expect(() =>
      Written(
        Root().insert([{ _id: "a" }, { _id: "a" }], { conflict: "update" }),
      ),
    ).to.throw(DuplicateKeyError);
  });

  it("refuses a conflict mode it does not know, naming the ones it does", () => {
    expect(() =>
      Written(
        Root().insert(
          { _id: "a" },
          WithForeign({ conflict: "update" }, "conflict", "merge"),
        ),
      ),
    ).to.throw(/conflict mode of update or replace/);
  });
});

describe("An update", () => {
  it("joins the rows the read found, sets each written column and counts only rows it changes", () => {
    const statement = Written(Root().get("a").update({ age: 4 }));
    expect(WrittenStatements(statement)).to.deep.equal([
      {
        sql: `${Joined(SELECTED_ROW)} SET \`w0\`.\`age\` = CAST(? AS DOUBLE) WHERE (NOT (\`w0\`.\`age\` <=> CAST(? AS DOUBLE)))`,
        args: ["", "a", 4, 4],
      },
    ]);
  });

  it("sets an undeclared key and removes one written as undefined, after setting", () => {
    const [bound] = WrittenStatements(
      Written(Root().get("a").update({ rev: "1", nickname: undefined })),
    );
    expect(bound.sql).to.include(
      "`w0`.`_extra` = JSON_REMOVE(JSON_SET(COALESCE(`w0`.`_extra`, JSON_OBJECT()), '$.\"rev\"', CAST(JSON_QUOTE(?) AS JSON)), '$.\"nickname\"')",
    );
  });

  it("clears a declared field written as undefined", () => {
    const [bound] = WrittenStatements(
      Written(Root().get("a").update({ age: undefined })),
    );
    expect(bound.sql).to.include("SET `w0`.`age` = NULL WHERE");
  });

  it("reads a mapper's row from the materialized read, so every assignment sees the row as it was", () => {
    const [bound] = WrittenStatements(
      Written(
        Root().update((doc) => ({
          age: doc.key("age"),
          name: doc.key("nickname"),
        })),
      ),
    );
    expect(bound.sql).to.include("SET `w0`.`age` = `t1`.`age`, `w0`.`name` = ");
    expect(bound.sql).to.include(
      "JSON_EXTRACT(`t1`.`_extra`, '$.\"nickname\"')",
    );
    expect(bound.sql).to.not.include("`w0`.`age` = `w0`");
  });

  it("narrows to the key a payload names, rather than renaming the row", () => {
    const [bound] = WrittenStatements(
      Written(Root().get("a").update({ _id: "b", age: 1 })),
    );
    expect(bound.sql).to.include("WHERE (`w0`.`_id` = ?) AND (NOT");
  });

  it("refuses a payload naming a key over many rows", () => {
    expect(() => Written(Root().update({ _id: "b", age: 1 }))).to.throw(
      /naming '_id' over a selection of many rows/,
    );
  });

  it("refuses a payload with nothing to write", () => {
    expect(() => Written(Root().get("a").update({ _id: "a" }))).to.throw(
      /nothing to write/,
    );
  });

  it("is allowed across instances, which assigns no instance", () => {
    const [bound] = WrittenStatements(
      Written(CrossInstanceRoot().update({ age: 1 })),
    );
    expect(bound.sql).to.not.include("`_instance` = ?");
  });
});

describe("A replace", () => {
  it("states every column of the rows it found and compares them all to count a change", () => {
    const [bound] = WrittenStatements(
      Written(Root().get("a").replace({ name: "A" })),
    );
    expect(bound.sql).to.equal(
      `${Joined(SELECTED_ROW)} SET \`w0\`.\`name\` = ?, \`w0\`.\`age\` = NULL, \`w0\`.\`isActive\` = NULL, \`w0\`.\`joined\` = NULL, \`w0\`.\`meta\` = NULL, \`w0\`.\`_extra\` = JSON_OBJECT() WHERE (NOT (\`w0\`.\`name\` <=> ?) OR NOT (\`w0\`.\`age\` <=> NULL) OR NOT (\`w0\`.\`isActive\` <=> NULL) OR NOT (\`w0\`.\`joined\` <=> NULL) OR NOT (\`w0\`.\`meta\` <=> NULL) OR NOT (\`w0\`.\`_extra\` <=> JSON_OBJECT()))`,
    );
  });

  it("refuses CROSS_INSTANCE by name", () => {
    expect(() => Written(CrossInstanceRoot().replace({ name: "A" }))).to.throw(
      /'replace' stage cannot write under CROSS_INSTANCE/,
    );
  });
});

describe("A delete", () => {
  it("removes the rows the read found, its order and bounds included", () => {
    const [bound] = WrittenStatements(
      Written(Root().orderBy("age").slice(0, 1).delete()),
    );
    expect(bound).to.deep.equal({
      sql: "DELETE /*+ NO_MERGE(`t1`) */ `w0` FROM `directory__people` AS `w0` JOIN (SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`name`, `t0`.`age`, `t0`.`isActive`, `t0`.`joined`, `t0`.`meta`, `t0`.`_extra` FROM `directory__people` AS `t0` WHERE (`t0`.`_instance` = ?) ORDER BY `t0`.`age` ASC LIMIT ? OFFSET ? FOR UPDATE) AS `t1` ON `w0`.`_instance` = `t1`.`_instance` AND `w0`.`_id` = `t1`.`_id`",
      args: ["", 1, 0],
    });
  });
});

describe("An atomic mutation", () => {
  it("updates the keyed row only where an undeclared revision holds the expected JSON string", () => {
    const [bound] = WrittenStatements(
      Written(
        Root().atomicMutation("a", {
          type: "update",
          patch: { age: 1 },
          revisionField: "rev",
          expectedRevision: "r0",
          nextRevision: "r1",
        }),
      ),
    );
    expect(bound).to.deep.equal({
      sql: "UPDATE `directory__people` AS `w0` SET `w0`.`age` = CAST(? AS DOUBLE), `w0`.`_extra` = JSON_SET(COALESCE(`w0`.`_extra`, JSON_OBJECT()), '$.\"rev\"', CAST(JSON_QUOTE(?) AS JSON)) WHERE `w0`.`_instance` = ? AND `w0`.`_id` = ? AND JSON_EXTRACT(`w0`.`_extra`, '$.\"rev\"') = CAST(? AS JSON)",
      args: [1, "r1", "", "a", '"r0"'],
    });
  });

  it("reads a missing revision as the key being absent", () => {
    const [bound] = WrittenStatements(
      Written(
        Root().atomicMutation("a", {
          type: "delete",
          revisionField: "rev",
          expectedRevision: { kind: "missing" },
        }),
      ),
    );
    expect(bound.sql).to.equal(
      "DELETE FROM `directory__people` AS `w0` WHERE `w0`.`_instance` = ? AND `w0`.`_id` = ? AND NOT JSON_CONTAINS_PATH(`w0`.`_extra`, 'one', '$.\"rev\"')",
    );
  });

  it("compares a declared field's equality by its column", () => {
    const [bound] = WrittenStatements(
      Written(
        Root().atomicMutation("a", {
          type: "deleteIfEqual",
          field: "name",
          expectedValue: "A",
        }),
      ),
    );
    expect(bound.sql).to.match(/AND `w0`\.`name` = \?$/);
  });
});
