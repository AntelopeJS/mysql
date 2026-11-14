import { expect } from "chai";
import type { Schema } from "@antelopejs/interface-database/schema";
import type { StagedObject } from "@antelopejs/interface-database/common";

import { GetDialect, Read } from "../connection";
import { type Sql, sql } from "../statement";
import { Render } from "../implementations/database/render";
import { BuildRoot } from "../implementations/database/selection";
import { DecodingContext } from "../implementations/database/context";
import { CompileSubquery } from "../implementations/database/subquery";
import { CompileExpression } from "../implementations/database/expression";
import {
  ApplyStages,
  CompileRelation,
} from "../implementations/database/pipeline";
import { Native, NativeCount, RegisterSales, type SalesTables } from "./sales";

type IntegerComparison = "gt" | "ge" | "lt" | "le" | "eq";

let sales: Schema<SalesTables>;

function Table(tableId: string) {
  return sales.instance().table(tableId);
}

function Compiled(query: StagedObject): Sql {
  const context = new DecodingContext(
    {
      expression: CompileExpression,
      subquery: CompileSubquery,
      relation: CompileRelation,
    },
    GetDialect(),
  );
  const root = BuildRoot(query.build(), context);
  return Render(ApplyStages(root.relation, root.rest, context));
}

/** The indexes the optimizer reads a query through, one per table the plan names. */
async function IndexesOf(query: StagedObject): Promise<string[]> {
  const plan = await Read(sql`EXPLAIN FORMAT=TRADITIONAL ${Compiled(query)}`);
  return plan.map((row) => String(row.get("key")));
}

describe("an external key that its column cannot hold", function () {
  this.timeout(30_000);
  before(async () => {
    sales = await RegisterSales();
  });

  for (const [table, key] of [
    ["contacts", "not-a-uuid"],
    ["accounts", "42abc"],
    ["accounts", "99999999999999999999"],
    ["accounts", ""],
    ["order_lines", "not json"],
    ["order_lines", '"0"'],
    ["order_lines", '["0"]'],
    ["order_lines", '["0", "1", "9"]'],
    ["order_lines", '["x", "1"]'],
    ["order_lines", '{"0": "1"}'],
  ]) {
    it(`gets nothing for ${JSON.stringify(key)} on ${table}, rather than failing the request`, async () => {
      expect(await Table(table).get(key).run()).to.equal(undefined);
    });
  }

  it("filters nothing for an enum label the type does not have", async () => {
    const total = await Table("accounts")
      .filter((row) => row.key("status").eq("archived"))
      .count()
      .run();
    expect(total).to.equal(0);
  });
});

describe("the indexes that serve reads of an external relation", function () {
  this.timeout(30_000);
  before(async () => {
    sales = await RegisterSales();
  });

  it("gets by a bigint _id through the primary key index", async () => {
    expect(await IndexesOf(Table("accounts").get("42"))).to.include("PRIMARY");
  });

  it("gets by a composite _id through the primary key index", async () => {
    expect(await IndexesOf(Table("order_lines").get('["4", "2"]'))).to.include(
      "PRIMARY",
    );
  });

  it("looks a foreign key up through the referenced primary key index", async () => {
    const query = Table("contacts")
      .slice(0, 3)
      .lookup(Table("accounts"), "account_id", "_id");
    expect(await IndexesOf(query)).to.include("PRIMARY");
  });

  it("ranges over a naive DATETIME through its own index", async () => {
    const query = Table("contacts").filter((row) =>
      row
        .key("created_at")
        .ge(new Date("2026-03-02T00:00:00Z"))
        .and(row.key("created_at").lt(new Date("2026-03-03T00:00:00Z"))),
    );
    expect(await IndexesOf(query)).to.include("contacts_created");
  });

  it("ranges over a DATE through its own index", async () => {
    const query = Table("accounts").filter((row) =>
      row.key("signed_on").ge(new Date("2026-10-20T00:00:00Z")),
    );
    expect(await IndexesOf(query)).to.include("accounts_signed");
  });

  it("orders by a bigint read as text in its own numeric order", async () => {
    const [first] = await Table("accounts")
      .orderBy("id", "asc")
      .slice(9, 10)
      .run();
    expect(first.id).to.equal("10");
  });
});

describe("numbers read from an external relation's exact types", function () {
  this.timeout(30_000);
  before(async () => {
    sales = await RegisterSales();
  });

  it("sums a decimal column exactly", async () => {
    const total = await Table("accounts")
      .filter((row) => row.key("active").eq(true))
      .sum("revenue")
      .run();
    const [expected] = await Native(
      sql`SELECT CAST(SUM(revenue) AS DOUBLE) AS total FROM sales.accounts WHERE active`,
    );
    expect(total).to.equal(Number(expected.total));
  });

  const INTEGER_COMPARISONS: [IntegerComparison, Sql][] = [
    ["gt", sql`>`],
    ["ge", sql`>=`],
    ["lt", sql`<`],
    ["le", sql`<=`],
    ["eq", sql`=`],
  ];

  for (const [method, operator] of INTEGER_COMPARISONS) {
    it(`keeps the meaning of '${method} 5.5' on an integer column`, async () => {
      const total = await Table("accounts")
        .filter((row) => row.key("score")[method](5.5))
        .count()
        .run();
      expect(total).to.equal(
        await NativeCount(
          sql`SELECT COUNT(*) FROM sales.accounts WHERE CAST(score AS DECIMAL(65,30)) ${operator} 5.5`,
        ),
      );
    });
  }
});

describe("inequality against an external column's own type", function () {
  this.timeout(30_000);
  before(async () => {
    sales = await RegisterSales();
  });

  const INEQUALITIES: [string, string | number, number][] = [
    ["ref", "not-a-uuid", 2],
    ["ref", "", 2],
    ["n", 5.5, 2],
    ["n", 5, 1],
  ];

  for (const [field, value, expected] of INEQUALITIES) {
    it(`answers ${field} ne ${JSON.stringify(value)} as the complement of eq, keeping NULL rows`, async () => {
      const unequal = await Table("flags")
        .filter((row) => row.key(field).ne(value))
        .count()
        .run();
      const equal = await Table("flags")
        .filter((row) => row.key(field).eq(value))
        .count()
        .run();
      expect(unequal).to.equal(expected);
      expect(unequal + equal).to.equal(2);
    });
  }
});
