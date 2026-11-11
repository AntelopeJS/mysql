import { expect } from "chai";
import type { SchemaDefinition } from "@antelopejs/interface-database/schema";

import { Logger } from "../logger";
import {
  AcquireConnection,
  GetSchemaPrefix,
  Read,
  type Row,
} from "../connection";
import { type Sql, ident, param, sql } from "../statement";
import { TableName } from "../implementations/database/identifier";
import { SessionOf } from "../implementations/database/locks";
import type { KeyPart } from "../implementations/database/paths";
import type { IndexPlan } from "../implementations/database/plan";
import {
  GetTablePlan,
  Schemas,
  WaitForIndexes,
} from "../implementations/database/schema";

interface CatalogIndex {
  readonly name: string;
  readonly unique: boolean;
  readonly comment: string;
  readonly parts: string;
}

const FIELDS = {
  sku: "string",
  price: "number",
  title: "object",
  tags: "string[]",
} as const;

const BARE: SchemaDefinition = { items: { fields: FIELDS, indexes: {} } };

/** One declared index of each kind the module builds. */
const EVERY_KIND: SchemaDefinition = {
  items: {
    fields: FIELDS,
    indexes: {
      price: {},
      sku: { unique: true, crossInstance: true },
      tags: { multi: true },
      titleFr: { fields: ["title.fr"] },
      color: {},
      owner: { fields: ["_internal.data.owner"] },
      wholeTitle: { fields: ["title"] },
    },
  },
};

const INSTANCES = ["alpha", "beta", "gamma"];
const ROWS_PER_INSTANCE = 700;

/** Seven hundred rows per instance, each field and `_extra` key distinct per row. */
function Seed(table: Sql, instance: string): Sql {
  const digits = sql`(SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)`;
  return sql`INSERT INTO ${table} (_id, _instance, sku, price, title, tags, _extra) SELECT CONCAT(${param(instance)}, '-', n), ${param(instance)}, CONCAT('sku-', n), n, JSON_OBJECT('fr', CONCAT('titre ', n), 'en', CONCAT('title ', n)), JSON_ARRAY(CONCAT('tag-', n), CONCAT('tag-', n + 1)), JSON_OBJECT('color', CONCAT('color-', n), '_internal', JSON_OBJECT('data', JSON_OBJECT('owner', CONCAT('owner-', n)))) FROM (SELECT a.d + 10 * b.d + 100 * c.d AS n FROM ${digits} AS a CROSS JOIN ${digits} AS b CROSS JOIN ${digits} AS c) AS numbers WHERE n < ${param(ROWS_PER_INSTANCE)}`;
}

function Table(schemaId: string): string {
  return TableName(GetSchemaPrefix(), schemaId, "items");
}

/** Runs a statement that answers no rows, on a pooled connection. */
async function Run(statement: Sql): Promise<void> {
  const connection = await AcquireConnection();
  try {
    await SessionOf(connection).apply(statement);
  } finally {
    connection.release();
  }
}

async function Reset(schemaId: string): Promise<void> {
  await Run(sql`DROP TABLE IF EXISTS ${ident(Table(schemaId))}`);
}

async function Register(
  schemaId: string,
  definition: SchemaDefinition,
): Promise<void> {
  await Schemas.register(schemaId, definition);
  await WaitForIndexes(schemaId);
}

function Text(row: Row, column: string): string {
  const cell = row.get(column);
  return Buffer.isBuffer(cell) ? cell.toString("utf8") : String(cell);
}

async function Catalog(schemaId: string): Promise<CatalogIndex[]> {
  const rows = await Read(
    sql`SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, INDEX_COMMENT AS comment, GROUP_CONCAT(COALESCE(COLUMN_NAME, EXPRESSION) ORDER BY SEQ_IN_INDEX SEPARATOR ' | ') AS parts FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${param(Table(schemaId))} AND INDEX_NAME <> 'PRIMARY' GROUP BY INDEX_NAME, NON_UNIQUE, INDEX_COMMENT ORDER BY INDEX_NAME`,
  );
  return rows.map((row) => ({
    name: Text(row, "name"),
    unique: Number(row.get("non_unique")) === 0,
    comment: Text(row, "comment"),
    parts: Text(row, "parts"),
  }));
}

/** The column each planned key part reads, as the catalog names it; an element part by its column. */
function PartColumn(part: KeyPart): string {
  return part.kind === "key" ? part.key.name : part.column;
}

/** The planned index of `name`, with the key column of its last part. */
function Planned(schemaId: string, name: string): IndexPlan {
  const found = GetTablePlan(schemaId, "items").indexes.find(
    (index) => index.name === name,
  );
  expect(found, `planned index ${name}`).to.not.equal(undefined);
  return found ?? GetTablePlan(schemaId, "items").indexes[0];
}

function KeyColumnOf(schemaId: string, name: string): Sql {
  const part = Planned(schemaId, name).parts.at(-1);
  return ident(part ? PartColumn(part) : name);
}

/** The index the server would read for a hand-written `SELECT _id ... WHERE condition`. */
async function IndexUsed(schemaId: string, condition: Sql): Promise<string> {
  const [plan] = await Read(
    sql`EXPLAIN FORMAT=TRADITIONAL SELECT _id FROM ${ident(Table(schemaId))} WHERE ${condition}`,
  );
  return Text(plan, "key");
}

async function CaptureWarnings(work: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const original = Logger.Warn.bind(Logger);
  Logger.Warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await work();
  } finally {
    Logger.Warn = original;
  }
  return warnings;
}

describe("indexes declared on a populated table", function () {
  this.timeout(60_000);
  const schemaId = "indexes_every_kind";
  const scoped = sql`_instance = 'beta' AND`;

  before(async () => {
    await Reset(schemaId);
    await Register(schemaId, BARE);
    for (const instance of INSTANCES) {
      await Run(Seed(ident(Table(schemaId)), instance));
    }
    expect(await Catalog(schemaId)).to.deep.equal([]);
    await Register(schemaId, EVERY_KIND);
    await Run(sql`ANALYZE TABLE ${ident(Table(schemaId))}`);
  });

  after(() => {
    Schemas.unregister(schemaId);
  });

  it("builds every declared kind in the background, each signed in its comment", async () => {
    const plan = GetTablePlan(schemaId, "items");
    const expected = plan.indexes
      .map((index) => ({
        name: index.name,
        unique: index.unique,
        comment: index.signature,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const built = await Catalog(schemaId);
    expect(
      built.map(({ name, unique, comment }) => ({ name, unique, comment })),
    ).to.deep.equal(expected);
    expect(built.map((index) => index.name)).to.deep.equal([
      "color",
      "owner",
      "price",
      "sku",
      "sku__g",
      "tags",
      "titleFr",
      "wholeTitle",
    ]);
  });

  it("keys each index on the planned columns, the cross-instance twin without the instance", async () => {
    const built = new Map(
      (await Catalog(schemaId)).map((index) => [index.name, index.parts]),
    );
    for (const index of GetTablePlan(schemaId, "items").indexes) {
      const parts = index.parts.map((part) =>
        part.kind === "elements" ? "cast(" : PartColumn(part),
      );
      const catalog = built.get(index.name) ?? "";
      for (const part of parts) {
        expect(catalog, index.name).to.contain(part);
      }
    }
    expect(built.get("sku__g")).to.not.contain("_instance");
    expect(built.get("tags")).to.match(/as char\(512\) array/);
  });

  it("serves an equality on a key column named in the query from its index", async () => {
    const lookups: [string, Sql][] = [
      ["price", sql`${scoped} price = 7`],
      ["sku", sql`${scoped} ${KeyColumnOf(schemaId, "sku")} = 'sku-7'`],
      ["sku__g", sql`${KeyColumnOf(schemaId, "sku__g")} = 'sku-7'`],
      [
        "titleFr",
        sql`${scoped} ${KeyColumnOf(schemaId, "titleFr")} = 'titre 7'`,
      ],
      ["color", sql`${scoped} ${KeyColumnOf(schemaId, "color")} = 'color-7'`],
      ["owner", sql`${scoped} ${KeyColumnOf(schemaId, "owner")} = 'owner-7'`],
      [
        "wholeTitle",
        sql`${scoped} ${KeyColumnOf(schemaId, "wholeTitle")} = '{"en": "title 7", "fr": "titre 7"}'`,
      ],
      ["tags", sql`${scoped} 'tag-7' MEMBER OF (JSON_EXTRACT(tags, '$'))`],
    ];
    for (const [index, condition] of lookups) {
      expect(await IndexUsed(schemaId, condition), index).to.equal(index);
    }
  });

  it("holds the value its key column reads, so the index finds the row the field names", async () => {
    const rows = await Read(
      sql`SELECT _id FROM ${ident(Table(schemaId))} FORCE INDEX (owner) WHERE ${scoped} ${KeyColumnOf(schemaId, "owner")} = 'owner-7'`,
    );
    expect(rows.map((row) => Text(row, "_id"))).to.deep.equal(["beta-7"]);
  });
});

describe("indexes whose declaration changes", function () {
  this.timeout(60_000);

  afterEach(() => {
    Schemas.unregister("indexes_swap");
    Schemas.unregister("indexes_refused");
  });

  it("swaps an index whose declaration changed for one built from the new one", async () => {
    const schemaId = "indexes_swap";
    await Reset(schemaId);
    await Register(schemaId, {
      items: { fields: FIELDS, indexes: { price: {} } },
    });
    await Run(Seed(ident(Table(schemaId)), "alpha"));
    await Register(schemaId, {
      items: {
        fields: FIELDS,
        indexes: { price: { fields: ["price", "sku"] } },
      },
    });
    const [price] = await Catalog(schemaId);
    expect(price.name).to.equal("price");
    expect(price.comment).to.equal(Planned(schemaId, "price").signature);
    expect(price.parts).to.equal(
      `_instance | price | ${Planned(schemaId, "price").parts.map(PartColumn)[2]}`,
    );
  });

  it("leaves a unique index it cannot build to the next registration, and builds the rest", async () => {
    const schemaId = "indexes_refused";
    await Reset(schemaId);
    await Register(schemaId, BARE);
    await Run(Seed(ident(Table(schemaId)), "alpha"));
    await Run(
      sql`UPDATE ${ident(Table(schemaId))} SET price = 1 WHERE _id IN ('alpha-1', 'alpha-2')`,
    );
    const warnings = await CaptureWarnings(() =>
      Register(schemaId, {
        items: {
          fields: FIELDS,
          indexes: { price: { unique: true }, sku: {} },
        },
      }),
    );
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.match(/could not addIndex 'price': Duplicate entry/);
    expect((await Catalog(schemaId)).map((index) => index.name)).to.deep.equal([
      "sku",
    ]);
  });
});
