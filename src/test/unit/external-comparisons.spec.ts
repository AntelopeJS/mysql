import { expect } from "chai";
import { SchemaInstance } from "@antelopejs/interface-database";
import {
  QueryStage,
  type StagedObject,
} from "@antelopejs/interface-database/common";

import { DIALECTS } from "../../dialect";
import type { CatalogColumn } from "../../dialect/external";
import { Bind } from "../../statement";
import { Render } from "../../implementations/database/render";
import { BuildRoot } from "../../implementations/database/selection";
import { DecodingContext } from "../../implementations/database/context";
import { CompileSubquery } from "../../implementations/database/subquery";
import { CompileExpression } from "../../implementations/database/expression";
import {
  ParseFieldType,
  type SchemaModel,
} from "../../implementations/database/fields";
import {
  type ColumnDescriptor,
  Describe,
  DescribeKey,
} from "../../implementations/database/external-types";
import {
  ApplyStages,
  CompileRelation,
} from "../../implementations/database/pipeline";
import type { TablePlan } from "../../implementations/database/plan";
import { Column } from "./external-fixture";

const mysql = DIALECTS.mysql;

function Field(column: CatalogColumn, declared: string) {
  const type = ParseFieldType(declared, column.name).type;
  return {
    column: column.name,
    type,
    native: Describe(mysql, column.name, type, column, column.name),
  };
}

function Key(columns: CatalogColumn[]): ColumnDescriptor[] {
  return columns.flatMap((column) => DescribeKey(mysql, column) ?? []);
}

const ID = Column("id", "bigint");
const SCORE = Column("score", "int");
const REVENUE = Column("revenue", "decimal(12,2)");
const ACCOUNT_ID = Column("account_id", "bigint");
const CONTACT_ID = Column("contact_id", "char(36)");
const ORDER_ID = Column("order_id", "int");
const LINE_NO = Column("line_no", "int");
const SIGNED_ON = Column("signed_on", "date");

const MODELS: SchemaModel = {
  accounts: {
    fields: {
      id: Field(ID, "string"),
      score: Field(SCORE, "number"),
      revenue: Field(REVENUE, "number"),
      signed_on: Field(SIGNED_ON, "date"),
    },
    external: { schema: "sales", table: "accounts", key: Key([ID]) },
  },
  contacts: {
    fields: { account_id: Field(ACCOUNT_ID, "string") },
    external: { schema: "sales", table: "contacts", key: Key([CONTACT_ID]) },
  },
  order_lines: {
    fields: {},
    external: {
      schema: "sales",
      table: "order_lines",
      key: Key([ORDER_ID, LINE_NO]),
    },
  },
  raw_log: {
    fields: { msg: Field(Column("msg", "text"), "string") },
    external: { schema: "sales", table: "raw_log" },
  },
};

interface Tables {
  accounts: {
    _id: string;
    id: string;
    score: number;
    revenue: number;
    signed_on: Date;
  };
  contacts: { account_id: string };
  order_lines: { line_no: number };
  raw_log: { msg: string };
}

function Table<K extends keyof Tables>(tableId: K, instanceId?: string) {
  const schema = new SchemaInstance<Tables>(
    QueryStage("schema", { id: "sales" }),
  );
  const instance = new SchemaInstance<Tables>(
    QueryStage("instance", { id: instanceId }),
    schema,
  );
  return instance.table(tableId);
}

function EmptyPlan(tableId: string): TablePlan {
  return {
    schemaId: "sales",
    tableId,
    table: tableId,
    columns: [],
    keyColumns: [],
    indexes: [],
  };
}

function Sql(query: StagedObject): string {
  const context = new DecodingContext(
    {
      expression: CompileExpression,
      subquery: CompileSubquery,
      relation: CompileRelation,
    },
    mysql,
    (schemaId, tableId) => ({
      schemaId,
      tableId,
      model: MODELS[tableId],
      plan: EmptyPlan(tableId),
      index: (name) => [name],
    }),
  );
  const root = BuildRoot(query.build(), context);
  return Bind(Render(ApplyStages(root.relation, root.rest, context))).sql;
}

describe("comparisons against an external relation's own column types", () => {
  it("reads the relation by its own names, with no instance to filter on", () => {
    expect(Sql(Table("accounts"))).to.match(
      /^SELECT CAST\(`t0`\.`id` AS CHAR\) AS `_id`, .* FROM `sales`\.`accounts` AS `t0`$/,
    );
  });

  it("compares a char(36) key bare, against the bound text", () => {
    expect(Sql(Table("contacts").get("x"))).to.contain(
      "WHERE (`t0`.`contact_id` = ?)",
    );
  });

  it("compares a bigint key bare, against a text read as a number only where it spells one", () => {
    expect(Sql(Table("accounts").get("42"))).to.contain(
      "(`t0`.`id` = CAST(IF(? REGEXP",
    );
  });

  it("keeps an integer column bare for an ordering against a number", () => {
    expect(
      Sql(Table("accounts").filter((row) => row.key("score").gt(5.5))),
    ).to.contain("(`t0`.`score` > CAST(? AS DOUBLE))");
  });

  it("matches only a whole number for equality on an integer column", () => {
    expect(
      Sql(Table("accounts").filter((row) => row.key("score").eq(5.5))),
    ).to.contain("(`t0`.`score` = IF(CAST(? AS DOUBLE) = TRUNCATE(");
  });

  it("answers inequality on a converted column as the complement of equality", () => {
    expect(
      Sql(Table("accounts").filter((row) => row.key("score").ne(5.5))),
    ).to.contain("IS NOT TRUE");
  });

  it("compares a decimal column bare against the number", () => {
    expect(
      Sql(Table("accounts").filter((row) => row.key("revenue").ge(10))),
    ).to.contain("(`t0`.`revenue` >= CAST(? AS DOUBLE))");
  });

  it("compares a DATE column bare against an instant, which its index serves", () => {
    expect(
      Sql(
        Table("accounts").filter((row) =>
          row.key("signed_on").ge(new Date("2026-01-01T00:00:00Z")),
        ),
      ),
    ).to.contain("(`t0`.`signed_on` >= CAST(? AS DATETIME(6)))");
  });

  it("matches a composite _id as the row of its key columns", () => {
    expect(Sql(Table("order_lines").get('["4", "2"]'))).to.contain(
      "(ROW(`t0`.`order_id`, `t0`.`line_no`) = ROW(",
    );
  });

  it("sorts by a composite _id through its key columns, in key order", () => {
    expect(Sql(Table("order_lines").orderBy("_id", "desc"))).to.contain(
      "ORDER BY `t0`.`order_id` DESC, `t0`.`line_no` DESC",
    );
  });

  it("sorts a bigint read as text by its bare column, in numeric order", () => {
    expect(Sql(Table("accounts").orderBy("id"))).to.contain(
      "ORDER BY `t0`.`id` ASC",
    );
  });

  it("refuses a named instance, naming the relation", () => {
    expect(() => Sql(Table("accounts", "tenant-1"))).to.throw(
      "`sales`.`accounts`",
    );
  });

  it("refuses to read by key a relation that has none", () => {
    expect(() => Sql(Table("raw_log").get("1"))).to.throw("no _id");
  });
});
