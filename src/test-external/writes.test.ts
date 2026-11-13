import { randomUUID } from "node:crypto";
import { expect } from "chai";
import type { Schema } from "@antelopejs/interface-database/schema";

import { GetDialect, Read } from "../connection";
import { ident, param, sql } from "../statement";
import { BuildRoot } from "../implementations/database/selection";
import { DecodingContext } from "../implementations/database/context";
import { CompileSubquery } from "../implementations/database/subquery";
import { CompileExpression } from "../implementations/database/expression";
import { SplitWrite } from "../implementations/database/writes";
import { WriteTargetOf } from "../implementations/database/writes-shared";
import { CompileExternalWrite } from "../implementations/database/external-writes";
import {
  ApplyStages,
  CompileRelation,
} from "../implementations/database/pipeline";
import {
  Failure,
  Reset,
  Rows,
  Seeded,
  Stored,
  WriteFailure,
} from "./writes-fixture";
import {
  Native,
  NativeCount,
  NativeWrite,
  RegisterSales,
  type SalesRow as Row,
  type SalesTables,
} from "./sales";

let sales: Schema<SalesTables>;

function Table(tableId: string) {
  return sales.instance().table(tableId);
}

describe("inserting into an external relation", function () {
  this.timeout(30_000);
  before(async () => {
    sales = await RegisterSales();
    await Reset();
  });

  it("answers the database's generated keys in input order, each reading back its own row", async () => {
    const labels = Array.from({ length: 1000 }, (_, n) => `label-${999 - n}`);
    const ids = await Table("w_serial")
      .insert(labels.map((label) => ({ label })))
      .run();
    expect(ids).to.have.length(1000);
    const rows = await Native(
      sql`SELECT CAST(id AS CHAR) AS id, label FROM sales.w_serial`,
    );
    const byId = new Map(rows.map((row) => [row.id, row.label]));
    expect(ids.map((id) => byId.get(id))).to.deep.equal(labels);
  });

  it("fills an omitted column with its DEFAULT and answers an AUTO_INCREMENT key as _id", async () => {
    const [id] = await Table("w_accounts").insert({ code: "d1" }).run();
    const row = await Table("w_accounts").get(id).run();
    expect(row).to.include({
      _id: id,
      id,
      code: "d1",
      status: "lead",
      upper_code: "D1",
    });
    expect(row.at).to.be.instanceOf(Date);
  });

  it("writes an explicit value into an AUTO_INCREMENT key, which MySQL accepts", async () => {
    expect(
      await Table("w_accounts").insert({ id: "500", code: "d5" }).run(),
    ).to.deep.equal(["500"]);
  });

  it("refuses to leave out a key only a DEFAULT expression fills, since no insert answers it back", async () => {
    const failure = await Failure(async () => {
      await Table("w_items").insert({ qty: 3 }).run();
    });
    expect(failure.message).to.contain("`sku`");
    expect(await NativeCount(sql`SELECT COUNT(*) FROM sales.w_items`)).to.equal(
      0,
    );
  });

  it("answers a supplied key, and a list then shows the row under it", async () => {
    const [account] = await Table("w_accounts").insert({ code: "d2" }).run();
    const sku = randomUUID();
    expect(
      await Table("w_items").insert({ sku, account_id: account, qty: 3 }).run(),
    ).to.deep.equal([sku]);
    const listed = await Table("w_items")
      .filter((row) => row.key("account_id").eq(account))
      .run();
    expect(listed.map((row) => row._id)).to.deep.equal([sku]);
  });

  it("writes a supplied composite _id into its key columns", async () => {
    const ids = await Table("w_lines")
      .insert({ _id: '["7", "2"]', qty: 1 })
      .run();
    expect(ids).to.deep.equal(['["7", "2"]']);
    expect(
      await NativeCount(
        sql`SELECT COUNT(*) FROM sales.w_lines WHERE order_id = 7 AND line_no = 2`,
      ),
    ).to.equal(1);
  });

  it("refuses an _id and a key field that disagree, writing nothing", async () => {
    const failure = await Failure(async () => {
      await Table("w_lines")
        .insert({
          _id: '["8", "1"]',
          order_id: 9,
          line_no: 1,
        })
        .run();
    });
    expect(failure.message).to.contain("order_id");
    expect(
      await NativeCount(
        sql`SELECT COUNT(*) FROM sales.w_lines WHERE order_id IN (8, 9)`,
      ),
    ).to.equal(0);
  });
});

describe("what an insert into an external relation refuses or upserts", function () {
  this.timeout(30_000);
  before(async () => {
    sales = await RegisterSales();
    await Reset();
  });

  for (const [description, document, named] of [
    [
      "a value for a generated column",
      { code: "x6", upper_code: "X" },
      "generated",
    ],
    ["a value for a SET column", { code: "x7", perms: "r" }, "read-only"],
    ["an undeclared key", { code: "x8", nickname: "n" }, "nickname"],
    ["an _internal key", { code: "x9", _internal: {} }, "_internal"],
  ] satisfies [string, Row, string][]) {
    it(`refuses ${description}, writing nothing`, async () => {
      const failure = await Failure(async () => {
        await Table("w_accounts").insert(document).run();
      });
      expect(failure.message).to.contain(named);
      expect(
        await NativeCount(
          sql`SELECT COUNT(*) FROM sales.w_accounts WHERE code = ${param(String(document.code))}`,
        ),
      ).to.equal(0);
    });
  }

  it("upserts on the key: update keeps an unmentioned column, replace clears it", async () => {
    await Table("w_lines").insert({ _id: '["20", "1"]', qty: 5 }).run();
    await Table("w_lines")
      .insert({ _id: '["20", "1"]' }, { conflict: "update" })
      .run();
    expect(
      await NativeCount(
        sql`SELECT qty AS count FROM sales.w_lines WHERE order_id = 20`,
      ),
    ).to.equal(5);
    await Table("w_lines")
      .insert({ order_id: 20, line_no: 1 }, { conflict: "replace" })
      .run();
    const [row] = await Native(
      sql`SELECT qty FROM sales.w_lines WHERE order_id = 20`,
    );
    expect(row.qty).to.equal(null);
  });

  it("upserts on the key only: a clash on another unique index still fails", async () => {
    const [first] = await Table("w_accounts").insert({ code: "u1" }).run();
    await Table("w_accounts").insert({ code: "u2" }).run();
    const failure = await WriteFailure(async () => {
      await Table("w_accounts")
        .insert({ _id: first, code: "u2" }, { conflict: "update" })
        .run();
    });
    expect(failure.kind).to.equal("duplicate");
    expect((await Table("w_accounts").get(first).run()).code).to.equal("u1");
  });
});

describe("values an external column cannot hold", function () {
  this.timeout(30_000);
  before(async () => {
    sales = await RegisterSales();
    await Reset();
  });

  const INVALID_VALUES: [string, Row, string][] = [
    ["w_accounts", { code: "v1", status: "archived" }, "status"],
    ["w_accounts", { code: "toolong" }, "code"],
    ["w_accounts", { code: "v2", revenue: 1e12 }, "revenue"],
    ["w_accounts", { code: "v3", seen: new Date("0999-12-31") }, "seen"],
    ["w_items", { sku: "x".repeat(37), qty: 1 }, "sku"],
    ["w_serial", { id: 5.5, label: "v3" }, "id"],
    ["w_lines", { order_id: 1, line_no: 1, qty: 1.5 }, "qty"],
  ];

  for (const [table, document, field] of INVALID_VALUES) {
    it(`refuses ${JSON.stringify(document[field])} for ${table}.${field} before writing, naming the field`, async () => {
      const failure = await WriteFailure(async () => {
        await Table(table).insert(document).run();
      });
      expect(failure.kind).to.equal("invalid");
      expect(failure.fields).to.deep.equal([field]);
      expect(failure.message).to.contain(`sales.${table}.${field}`);
      expect(
        await NativeCount(sql`SELECT COUNT(*) FROM ${Rows(table)}`),
      ).to.equal(0);
    });
  }
});

describe("writing back what was read from an external relation", function () {
  this.timeout(30_000);
  before(async () => {
    sales = await RegisterSales();
    await Reset();
  });

  it("changes no byte of what a lossy read cannot spell, and counts no changed row", async () => {
    const id = await Seeded("r1");
    const before = await Stored(id);
    const stored = await Table("w_accounts").get(id).run();
    expect(await Table("w_accounts").get(id).update(stored).run()).to.equal(0);
    expect(await Stored(id)).to.deep.equal(before);
  });

  it("writes the one field an edit changed and keeps every other stored value", async () => {
    const id = await Seeded("r2");
    const before = await Stored(id);
    const stored = await Table("w_accounts").get(id).run();
    expect(
      await Table("w_accounts")
        .get(id)
        .update({ ...stored, code: "r2b" })
        .run(),
    ).to.equal(1);
    expect(await Stored(id)).to.deep.equal({
      ...before,
      code: "r2b",
      upper_code: "R2B",
    });
  });

  it("writes nothing when _id or a key field names another row", async () => {
    const id = await Seeded("r3");
    const other = await Seeded("r4");
    expect(
      await Table("w_accounts")
        .get(id)
        .update({ _id: other, code: "zz" })
        .run(),
    ).to.equal(0);
    expect(
      await Table("w_accounts").get(id).update({ id: other, code: "zz" }).run(),
    ).to.equal(0);
    expect((await Stored(id)).code).to.equal("r3");
  });

  it("replaces: clears a silent field, resets a defaulted one and leaves the generated column to the database", async () => {
    const id = await Seeded("r5");
    await NativeWrite(
      sql`UPDATE sales.w_accounts SET email = 'a@b.c', status = 'active' WHERE id = ${param(id)}`,
    );
    expect(
      await Table("w_accounts").get(id).replace({ code: "r5b" }).run(),
    ).to.equal(1);
    const [row] = await Native(
      sql`SELECT email, code, upper_code, CAST(status AS CHAR) AS status FROM sales.w_accounts WHERE id = ${param(id)}`,
    );
    expect(row).to.deep.equal({
      email: null,
      code: "r5b",
      upper_code: "R5B",
      status: "lead",
    });
  });
});

describe("editing through a key field read lossily, as data-api's edit sends it", function () {
  this.timeout(30_000);
  before(async () => {
    sales = await RegisterSales();
    await Reset();
  });

  for (const [table, seed, id, field] of [
    [
      "w_events",
      sql`INSERT INTO sales.w_events VALUES ('2026-01-01 10:00:00.123456', 'a')`,
      "2026-01-01 10:00:00.123456",
      "msg",
    ],
    [
      "w_big",
      sql`INSERT INTO sales.w_big VALUES (9007199254740993, 'a')`,
      "9007199254740993",
      "label",
    ],
  ] as const) {
    it(`edits ${table}, whose key field is not read as the key's text, and answers 1`, async () => {
      await NativeWrite(seed);
      const stored = await Table(table).get(id).run();
      expect(stored._id).to.equal(id);
      expect(
        await Table(table)
          .get(id)
          .update({ ...stored, [field]: "b" })
          .run(),
      ).to.equal(1);
      expect(
        await NativeCount(
          sql`SELECT COUNT(*) FROM ${Rows(table)} WHERE ${ident(field)} = 'b'`,
        ),
      ).to.equal(1);
    });
  }
});

describe("selecting the rows an external write changes", function () {
  this.timeout(30_000);
  before(async () => {
    sales = await RegisterSales();
    await Reset();
  });

  it("updates rows selected by composite _id", async () => {
    await Table("w_lines")
      .insert([
        { _id: '["30", "1"]', qty: 1 },
        { _id: '["30", "2"]', qty: 1 },
        { _id: '["30", "3"]', qty: 1 },
      ])
      .run();
    expect(
      await Table("w_lines")
        .getAll(['["30", "1"]', '["30", "3"]'])
        .update({ qty: 9 })
        .run(),
    ).to.equal(2);
    expect(
      await NativeCount(
        sql`SELECT COUNT(*) FROM sales.w_lines WHERE order_id = 30 AND qty = 9`,
      ),
    ).to.equal(2);
  });

  it("deletes by _id and by filter, answering the count", async () => {
    const id = await Seeded("r6");
    await Seeded("r7");
    expect(await Table("w_accounts").get(id).delete().run()).to.equal(1);
    expect(
      await Table("w_accounts")
        .filter((row) => row.key("code").eq("r7"))
        .delete()
        .run(),
    ).to.equal(1);
    expect(
      await NativeCount(
        sql`SELECT COUNT(*) FROM sales.w_accounts WHERE code IN ('r6', 'r7')`,
      ),
    ).to.equal(0);
  });

  it("targets an edit through the primary key index", async () => {
    const id = await Seeded("p1");
    const context = new DecodingContext(
      {
        expression: CompileExpression,
        subquery: CompileSubquery,
        relation: CompileRelation,
      },
      GetDialect(),
    );
    const root = BuildRoot(
      Table("w_accounts").get(id).update({ code: "p" }).build(),
      context,
    );
    const split = SplitWrite(root.rest);
    const relation = ApplyStages(root.relation, split.pipeline, context);
    if (!split.write) throw new Error("the query was expected to write");
    const statement = CompileExternalWrite(
      WriteTargetOf(root, relation),
      split.write,
      context,
    );
    if (statement.kind !== "count" || !statement.statement) {
      throw new Error("the update was expected to compile to one statement");
    }
    const plan = await Read(
      sql`EXPLAIN FORMAT=TRADITIONAL ${statement.statement}`,
    );
    const target = plan.find((row) => row.get("table") === "w0");
    expect(target?.get("key")).to.equal("PRIMARY");
  });

  it("leaves a relation without a key unwritable, naming it", async () => {
    const failure = await Failure(async () => {
      await Table("raw_log")
        .filter((row) => row.key("msg").eq("r1"))
        .delete()
        .run();
    });
    expect(failure.message).to.contain("`sales`.`raw_log`");
  });

  it("still refuses atomicMutation, naming the stage", async () => {
    const failure = await Failure(async () => {
      await Table("w_accounts")
        .atomicMutation("1", {
          type: "update",
          revisionField: "code",
          expectedRevision: "a",
          nextRevision: "b",
          patch: {},
        })
        .run();
    });
    expect(failure.message).to.contain("atomicMutation");
  });
});

describe("what the database refuses on a write to an external relation", function () {
  this.timeout(30_000);
  before(async () => {
    sales = await RegisterSales();
    await Reset();
  });

  it("reports a duplicate value of a unique index, naming it", async () => {
    await Table("w_accounts").insert({ code: "e1" }).run();
    const failure = await WriteFailure(async () => {
      await Table("w_accounts").insert({ code: "e1" }).run();
    });
    expect(failure.kind).to.equal("duplicate");
    expect(failure.constraint).to.equal("w_accounts_code_key");
    expect(failure.message).to.contain("'e1'");
  });

  it("reports a missing required field, naming it", async () => {
    const failure = await WriteFailure(async () => {
      await Table("w_items").insert({ sku: randomUUID(), qty: null }).run();
    });
    expect(failure.kind).to.equal("missing");
    expect(failure.fields).to.deep.equal(["qty"]);
  });

  it("reports a reference to a row that does not exist", async () => {
    const failure = await WriteFailure(async () => {
      await Table("w_items")
        .insert({
          sku: randomUUID(),
          account_id: "999999",
          qty: 1,
        })
        .run();
    });
    expect(failure.kind).to.equal("reference");
    expect(failure.constraint).to.equal("w_items_account_id_fkey");
  });

  it("reports deleting a row that is still referenced", async () => {
    const [account] = await Table("w_accounts")
      .insert({
        code: "e2",
      })
      .run();
    await Table("w_items")
      .insert({
        sku: randomUUID(),
        account_id: account,
        qty: 1,
      })
      .run();
    const failure = await WriteFailure(async () => {
      await Table("w_accounts").get(account).delete().run();
    });
    expect(failure.kind).to.equal("referenced");
  });

  it("reports a broken check constraint", async () => {
    const failure = await WriteFailure(async () => {
      await Table("w_accounts").insert({ code: "e3", revenue: -1 }).run();
    });
    expect(failure.kind).to.equal("check");
    expect(failure.constraint).to.equal("w_accounts_revenue_check");
  });
});
