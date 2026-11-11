import { expect } from "chai";
import type { TableDefinition } from "@antelopejs/interface-database/schema";

import { DIALECTS } from "../../dialect";
import { Bind, type Sql, ident } from "../../statement";
import { ParseTable } from "../../implementations/database/fields";
import type { KeyColumn, KeyPart } from "../../implementations/database/paths";
import { BuildTablePlan } from "../../implementations/database/plan";
import { ColumnRowSource } from "../../implementations/database/row-source";
import type { TablePlan } from "../../implementations/database/plan";

const MYSQL = DIALECTS.mysql;
const GENERATION = /GENERATED ALWAYS AS \((.*)\) VIRTUAL COMMENT /s;

const DEFINITION: TableDefinition = {
  fields: {
    name: "string",
    title: "object",
    stats: { rank: "number", active: "boolean", label: "string" },
  },
  indexes: {
    name: {},
    nameExact: { fields: ["name"], unique: true },
    title: {},
    rank: { fields: ["stats.rank"] },
    active: { fields: ["stats.active"] },
    label: { fields: ["stats.label"] },
    labelExact: { fields: ["stats.label"], unique: true },
    nickname: { fields: ["nickname"] },
    nested: { fields: ["_internal.data.owner"] },
  },
};

function Plan(): TablePlan {
  return BuildTablePlan(
    "shop",
    "items",
    DEFINITION,
    ParseTable(DEFINITION, "shop.items"),
    { prefix: "", session: MYSQL.session },
  ).plan;
}

function Texts(statement: Sql): string {
  return Bind(statement).sql;
}

/** The expression the server is told to evaluate for the key column, out of its `ADD COLUMN`. */
function Generated(key: KeyColumn): string {
  const text = Texts(MYSQL.ddl.addKeyColumn("items", key));
  const match = GENERATION.exec(text);
  expect(match, text).to.not.equal(null);
  return match?.[1] ?? "";
}

/**
 * What the compiler reads for the same part of an index on a row of the table: the value the key
 * column is compared by, cut to the column's width as a comparison cuts its bound. A `json` key
 * holds the canonical text of the value the compiler reads whole.
 */
function Read(key: KeyColumn): string {
  const part: KeyPart = { kind: "key", field: key.name, key };
  const source = new ColumnRowSource(
    MYSQL,
    (column, type) => ({ sql: ident(column), type }),
    ParseTable(DEFINITION, "shop.items"),
  );
  const { value } = source.indexed(part);
  const whole =
    key.read === "json" ? MYSQL.sql.json.text(value.sql) : value.sql;
  const fit = "fit" in key ? key.fit : undefined;
  return Texts(
    fit?.kind === "prefix" ? MYSQL.sql.scalar.left(whole, fit.width) : whole,
  );
}

describe("a key column's generation expression", () => {
  const plan = Plan();

  it("covers every way a key column reads its source, exact and prefix", () => {
    const kinds = new Set(
      plan.keyColumns.map((key) =>
        "fit" in key ? `${key.read}:${key.fit.kind}` : key.read,
      ),
    );
    expect([...kinds].sort()).to.deep.equal([
      "bool",
      "double",
      "json:prefix",
      "string:exact",
      "string:prefix",
      "text:exact",
      "text:prefix",
    ]);
  });

  it("is the read the compiler makes of the same value, for every key column", () => {
    for (const key of plan.keyColumns) {
      expect(Generated(key), key.definition).to.equal(Read(key));
    }
  });
});
