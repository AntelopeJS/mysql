import { expect } from "chai";
import type { TableDefinition } from "@antelopejs/interface-database/schema";

import type { MigrationMode } from "../../config";
import { Bind } from "../../statement";
import { DIALECTS, type ObservedTable } from "../../dialect";
import { ParseTable } from "../../implementations/database/fields";
import type { KeyPart } from "../../implementations/database/paths";
import {
  BuildTablePlan,
  type TablePlan,
} from "../../implementations/database/plan";
import {
  type IndexStep,
  NextIndexStep,
  NextTableStep,
  OwnershipComment,
  PENDING,
  type TableStep,
} from "../../implementations/database/convergence";

const MYSQL = DIALECTS.mysql;
const SAFE: MigrationMode = "safe";
const DESTRUCTIVE: MigrationMode = "destructive";
const NOTHING_SKIPPED: ReadonlySet<string> = new Set();

/** The type the catalog reports for each column a plan stores. */
function CatalogType(column: TablePlan["columns"][number]): string {
  switch (column.role) {
    case "id":
    case "instance":
      return `varchar(${column.chars})`;
    case "extra":
      return "json";
    case "declared":
      return Bind(MYSQL.sql.physical(column.type)).sql.toLowerCase();
  }
}

function Plan(definition: TableDefinition): TablePlan {
  return BuildTablePlan(
    "shop",
    "items",
    definition,
    ParseTable(definition, "shop.items"),
    { prefix: "", session: MYSQL.session },
  ).plan;
}

function PartColumn(part: KeyPart): string | undefined {
  switch (part.kind) {
    case "key":
      return part.key.name;
    case "elements":
      return undefined;
    default:
      return part.column;
  }
}

/** The catalog a `CREATE TABLE` of the plan leaves behind. */
function Created(plan: TablePlan): ObservedTable {
  return {
    kind: "table",
    comment: OwnershipComment(plan),
    columns: [
      ...plan.columns.map((column) => ({
        name: column.name,
        type: CatalogType(column),
        generated: false,
        comment: "",
      })),
      ...plan.keyColumns.map((key) => ({
        name: key.name,
        type: "varchar(640)",
        generated: true,
        comment: key.definition,
      })),
    ],
    indexes: plan.indexes.map((index) => ({
      name: index.name,
      unique: index.unique,
      comment: index.signature,
      columns: index.parts.map(PartColumn),
    })),
    triggers: [],
  };
}

function Without(observed: ObservedTable, name: string): ObservedTable {
  return {
    ...observed,
    columns: observed.columns.filter((column) => column.name !== name),
    indexes: observed.indexes.filter((index) => index.name !== name),
  };
}

function Commented(
  observed: ObservedTable,
  name: string,
  comment: string,
): ObservedTable {
  return {
    ...observed,
    columns: observed.columns.map((column) =>
      column.name === name ? { ...column, comment } : column,
    ),
  };
}

function Typed(
  observed: ObservedTable,
  name: string,
  type: string,
): ObservedTable {
  return {
    ...observed,
    columns: observed.columns.map((column) =>
      column.name === name ? { ...column, type } : column,
    ),
  };
}

function Step(
  plan: TablePlan,
  observed: ObservedTable | undefined,
  mode = SAFE,
): TableStep | undefined {
  return NextTableStep(MYSQL, mode, plan, observed).step;
}

function Text(step: TableStep | IndexStep | undefined): string {
  expect(step, "a step").to.not.equal(undefined);
  if (!step) {
    return "";
  }
  return Bind(step.kind === "backfill" ? step.settle : step.sql).sql;
}

const ITEMS: TableDefinition = {
  fields: { name: "string", price: "number", title: "object" },
  indexes: {
    name: { unique: true },
    price: {},
    titleFr: { fields: ["title.fr"] },
  },
};

const BARE: TableDefinition = {
  fields: { name: "string", price: "number", title: "object" },
  indexes: {},
};

describe("NextTableStep", () => {
  const plan = Plan(ITEMS);
  const created = Created(plan);

  it("creates an absent table with its columns, key columns and indexes, signed as the module's", () => {
    const step = Step(plan, undefined);
    expect(step?.kind).to.equal("createTable");
    const text = Text(step);
    expect(text).to.contain(`COMMENT='${OwnershipComment(plan)}'`);
    for (const key of plan.keyColumns) {
      expect(text).to.contain(`\`${key.name}\``);
    }
    for (const index of plan.indexes) {
      expect(text).to.contain(`COMMENT '${index.signature}'`);
    }
  });

  it("does nothing against the catalog its own creation leaves", () => {
    expect(NextTableStep(MYSQL, SAFE, plan, created)).to.deep.equal({
      step: undefined,
      warnings: [],
    });
    expect(Step(plan, created, DESTRUCTIVE)).to.equal(undefined);
  });

  it("refuses a table at its name that another owner signed, and a view", () => {
    const foreign = { ...created, comment: "hand made" };
    expect(() => Step(plan, foreign)).to.throw(/was not created by/);
    const view = { ...created, kind: "other" as const };
    expect(() => Step(plan, view)).to.throw(/was not created by/);
  });

  it("refuses a table another schema and table of the same physical name signed", () => {
    const other = Plan(ITEMS);
    const renamed = {
      ...created,
      comment: OwnershipComment({ ...other, tableId: "Items" }),
    };
    expect(() => Step(plan, renamed)).to.throw(/'shop.items'/);
  });
});

describe("NextTableStep on a declared column", () => {
  const plan = Plan(ITEMS);
  const created = Created(plan);

  it("adds a missing declared column, marked pending", () => {
    const step = Step(plan, Without(created, "price"));
    expect(step).to.include({ kind: "addColumn", target: "price" });
    expect(Text(step)).to.contain(`COMMENT '${PENDING}'`);
  });

  it("backfills a pending column, then settles it with an empty comment", () => {
    const step = Step(plan, Commented(created, "price", PENDING));
    expect(step).to.include({ kind: "backfill", target: "price" });
    expect(Text(step)).to.match(
      /MODIFY COLUMN `price` DOUBLE NULL COMMENT ''$/,
    );
  });

  it("refuses a changed column type in safe mode, naming the column and both types", () => {
    const observed = Typed(created, "price", "longtext");
    expect(() => Step(plan, observed)).to.throw(
      /'price' on 'shop__items' is longtext but the schema declares double; set migrations: "destructive"/,
    );
  });

  it("retypes a changed column in destructive mode, keeping a pending column pending", () => {
    const observed = Commented(
      Typed(created, "price", "longtext"),
      "price",
      PENDING,
    );
    const step = Step(plan, observed, DESTRUCTIVE);
    expect(step).to.include({ kind: "retypeColumn", target: "price" });
    expect(Text(step)).to.contain(`DOUBLE NULL COMMENT '${PENDING}'`);
    const backfill = Step(
      plan,
      Commented(created, "price", PENDING),
      DESTRUCTIVE,
    );
    expect(backfill?.kind).to.equal("backfill");
  });
});

describe("NextTableStep on columns nothing declares", () => {
  const plan = Plan(ITEMS);
  const created = Created(plan);

  it("warns about an undeclared column in safe mode and keeps it", () => {
    const advice = NextTableStep(MYSQL, SAFE, Plan(BARE), Created(plan));
    expect(advice.step).to.equal(undefined);
    expect(advice.warnings).to.have.length(0);
    const extra = {
      ...created,
      columns: [
        ...created.columns,
        { name: "legacy", type: "longtext", generated: false, comment: "" },
      ],
    };
    const warned = NextTableStep(MYSQL, SAFE, plan, extra);
    expect(warned.step).to.equal(undefined);
    expect(warned.warnings).to.deep.equal([
      `Column 'legacy' on 'shop__items' is no longer declared and was left in place; set migrations: "destructive" to drop it`,
    ]);
  });

  it("drops an undeclared column in destructive mode, with the indexes over it", () => {
    const fewer = Plan({
      fields: { name: "string", title: "object" },
      indexes: { name: { unique: true }, titleFr: { fields: ["title.fr"] } },
    });
    const step = Step(fewer, created, DESTRUCTIVE);
    expect(step).to.include({ kind: "dropColumn", target: "price" });
    expect(Text(step)).to.equal(
      "ALTER TABLE `shop__items` DROP INDEX `price`, DROP COLUMN `price`",
    );
  });

  it("drops stale key columns and their indexes before a destructive drop or retype", () => {
    const fewer = Plan({
      fields: { name: "string", price: "number" },
      indexes: {},
    });
    const step = Step(fewer, created, DESTRUCTIVE);
    expect(step?.kind).to.equal("dropStaleKeys");
    const text = Text(step);
    for (const key of plan.keyColumns) {
      expect(text).to.contain(`DROP COLUMN \`${key.name}\``);
    }
    expect(text).to.contain("DROP INDEX `name`");
    expect(text).to.contain("DROP INDEX `titleFr`");
  });

  it("leaves stale key columns to the index phase when nothing destructive is planned", () => {
    expect(Step(Plan(BARE), created, DESTRUCTIVE)).to.equal(undefined);
    const retyped = Typed(created, "price", "longtext");
    expect(() => Step(Plan(BARE), retyped, SAFE)).to.throw(/destructive/);
  });

  it("adds a missing key column after the declared columns", () => {
    const [key] = plan.keyColumns;
    const step = Step(plan, Without(created, key.name));
    expect(step).to.include({ kind: "addKeyColumn", target: key.name });
    expect(Text(step)).to.contain(`COMMENT '${key.definition}'`);
    const both = Without(Without(created, key.name), "price");
    expect(Step(plan, both)?.kind).to.equal("addColumn");
  });

  it("retypes before it backfills, and backfills before it drops", () => {
    const fewer = Plan({
      fields: { name: "string", price: "number" },
      indexes: {},
    });
    const bare = Created(Plan(BARE));
    const observed = Commented(
      Typed(bare, "price", "longtext"),
      "name",
      PENDING,
    );
    expect(Step(fewer, observed, DESTRUCTIVE)?.kind).to.equal("retypeColumn");
    const retyped = Commented(bare, "name", PENDING);
    expect(Step(fewer, retyped, DESTRUCTIVE)?.kind).to.equal("backfill");
    expect(Step(fewer, bare, DESTRUCTIVE)?.kind).to.equal("dropColumn");
  });
});

describe("NextIndexStep", () => {
  const plan = Plan(ITEMS);
  const created = Created(plan);

  function Index(observed: ObservedTable, skipped = NOTHING_SKIPPED) {
    return NextIndexStep(MYSQL, plan, observed, skipped);
  }

  it("does nothing once every declared index is built and signed", () => {
    expect(Index(created)).to.equal(undefined);
  });

  it("builds an absent index online, signed in the same statement", () => {
    const step = Index(Without(created, "price"));
    expect(step).to.include({ kind: "addIndex", target: "price" });
    expect(Text(step)).to.match(
      /^ALTER TABLE `shop__items` ADD INDEX `price` \(`_instance`, `price`\) COMMENT '[^']+', ALGORITHM=INPLACE, LOCK=NONE$/,
    );
  });

  it("swaps an index whose signature differs, and an unsigned one at a declared name, in one statement", () => {
    for (const comment of ["antelopejs:1:btree:_instance,old", ""]) {
      const observed = {
        ...created,
        indexes: created.indexes.map((index) =>
          index.name === "price" ? { ...index, comment } : index,
        ),
      };
      const step = Index(observed);
      expect(step).to.include({ kind: "swapIndex", target: "price" });
      expect(Text(step)).to.match(/DROP INDEX `price`, ADD INDEX `price`/);
    }
  });

  it("drops an index it signed that nothing declares, and leaves a hand-made one", () => {
    const extra = (comment: string) => ({
      ...created,
      indexes: [
        ...created.indexes,
        {
          name: "old",
          unique: false,
          comment,
          columns: ["_instance", "price"],
        },
      ],
    });
    expect(Index(extra("antelopejs:1:btree:_instance,price"))).to.include({
      kind: "dropIndex",
      target: "old",
    });
    expect(Index(extra("made by hand"))).to.equal(undefined);
  });

  it("drops a stale key column once no index keys on it, and keeps one a hand-made index uses", () => {
    const stale = {
      name: "__k_old_12345678",
      type: "varchar(640)",
      generated: true,
      comment: 'antelopejs:1:key:string:prefix:640:_extra:["old"]',
    };
    const observed = { ...created, columns: [...created.columns, stale] };
    const step = Index(observed);
    expect(step).to.include({ kind: "dropKeyColumn", target: stale.name });
    expect(Text(step)).to.equal(
      `ALTER TABLE \`shop__items\` DROP COLUMN \`${stale.name}\``,
    );
    const used = {
      ...observed,
      indexes: [
        ...observed.indexes,
        { name: "byHand", unique: false, comment: "", columns: [stale.name] },
      ],
    };
    expect(Index(used)).to.equal(undefined);
  });

  it("builds every declared index before it drops anything", () => {
    const observed = {
      ...Without(created, "price"),
      indexes: [
        ...Without(created, "price").indexes,
        {
          name: "old",
          unique: false,
          comment: "antelopejs:1:btree:x",
          columns: [],
        },
      ],
    };
    expect(Index(observed)?.kind).to.equal("addIndex");
  });

  it("leaves an index it already failed on for the next registration", () => {
    const observed = Without(Without(created, "price"), "name");
    expect(Index(observed)?.target).to.equal("name");
    expect(Index(observed, new Set(["NAME"]))?.target).to.equal("price");
    expect(Index(observed, new Set(["name", "price"]))).to.equal(undefined);
  });

  it("builds a multi-valued index with writes blocked, which is all the server offers for one", () => {
    const tagged = Plan({
      fields: { tags: "string[]" },
      indexes: { tags: { multi: true } },
    });
    const step = NextIndexStep(
      MYSQL,
      tagged,
      { ...Created(tagged), indexes: [] },
      NOTHING_SKIPPED,
    );
    expect(Text(step)).to.match(
      /ADD INDEX `tags` \(`_instance`, \(CAST\(JSON_EXTRACT\(`tags`, '\$'\) AS CHAR\(512\) ARRAY\)\)\) COMMENT '[^']+', LOCK=SHARED$/,
    );
  });
});
