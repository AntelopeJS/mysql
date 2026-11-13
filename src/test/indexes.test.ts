import { expect } from "chai";
import {
  Schema,
  type SchemaDefinition,
} from "@antelopejs/interface-database/schema";

import { Logger } from "../logger";
import { GetDialect, Read, type Row } from "../connection";
import { type Sql, ident, param, sql } from "../statement";
import { KeyColumnsOf, type KeyPart } from "../implementations/database/paths";
import type { IndexPlan } from "../implementations/database/plan";
import {
  GetTablePlan,
  Schemas,
  WaitForIndexes,
} from "../implementations/database/schema";
import { IndexExpression, Numbers, PhysicalTable, Run } from "./tables";

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
  return sql`INSERT INTO ${table} (_id, _instance, sku, price, title, tags, _extra) SELECT CONCAT(${param(instance)}, '-', n), ${param(instance)}, CONCAT('sku-', n), n, JSON_OBJECT('fr', CONCAT('titre ', n), 'en', CONCAT('title ', n)), JSON_ARRAY(CONCAT('tag-', n), CONCAT('tag-', n + 1)), JSON_OBJECT('color', CONCAT('color-', n), '_internal', JSON_OBJECT('data', JSON_OBJECT('owner', CONCAT('owner-', n)))) FROM ${Numbers(3)} AS numbers WHERE n < ${param(ROWS_PER_INSTANCE)}`;
}

async function Reset(schemaId: string): Promise<void> {
  await Run(sql`DROP TABLE IF EXISTS ${ident(PhysicalTable(schemaId))}`);
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
    sql`SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, INDEX_COMMENT AS comment, GROUP_CONCAT(COALESCE(COLUMN_NAME, ${IndexExpression()}) ORDER BY SEQ_IN_INDEX SEPARATOR ' | ') AS parts FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${param(PhysicalTable(schemaId))} AND INDEX_NAME <> 'PRIMARY' GROUP BY INDEX_NAME, NON_UNIQUE, INDEX_COMMENT ORDER BY INDEX_NAME`,
  );
  return rows.map((row) => ({
    name: Text(row, "name"),
    unique: Number(row.get("non_unique")) === 0,
    comment: Text(row, "comment"),
    parts: Text(row, "parts"),
  }));
}

/** The columns each planned key part reads, as the catalog names them; an element part by its column. */
function PartColumns(part: KeyPart): string[] {
  const keys = KeyColumnsOf(part).map((key) => key.name);
  return keys.length > 0 || !("column" in part) ? keys : [part.column];
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
  return ident(part ? (PartColumns(part).at(0) ?? name) : name);
}

/**
 * An equality on the value key of index `name`'s last part, as the compiler spells it: the text
 * tagged with the value's kind, so the index can serve it.
 */
function ValueKeyEquals(
  schemaId: string,
  name: string,
  kind: "string" | "object",
  text: string,
): Sql {
  const part = Planned(schemaId, name).parts.at(-1);
  expect(part?.kind, name).to.equal("value");
  const [held] = part ? PartColumns(part) : [];
  const json = GetDialect().sql.json;
  return sql`${ident(held)} = ${json.tagged(json.ranks[kind], param(text))}`;
}

/** The index the server would read for a hand-written `SELECT _id ... WHERE condition`. */
async function IndexUsed(schemaId: string, condition: Sql): Promise<string> {
  const [plan] = await Read(
    sql`EXPLAIN FORMAT=TRADITIONAL SELECT _id FROM ${ident(PhysicalTable(schemaId))} WHERE ${condition}`,
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
      await Run(Seed(ident(PhysicalTable(schemaId)), instance));
    }
    expect(await Catalog(schemaId)).to.deep.equal([]);
    await Register(schemaId, EVERY_KIND);
    await Run(sql`ANALYZE TABLE ${ident(PhysicalTable(schemaId))}`);
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
    const multi = GetDialect().session.multiValuedIndex ? ["tags"] : [];
    expect(built.map((index) => index.name)).to.deep.equal([
      "color",
      "owner",
      "price",
      "sku",
      "sku__g",
      ...multi,
      "titleFr",
      "wholeTitle",
    ]);
  });

  it("keys each index on the planned columns, the cross-instance twin without the instance", async () => {
    const built = new Map(
      (await Catalog(schemaId)).map((index) => [index.name, index.parts]),
    );
    for (const index of GetTablePlan(schemaId, "items").indexes) {
      const parts = index.parts.flatMap((part) =>
        part.kind === "elements" ? ["cast("] : PartColumns(part),
      );
      const catalog = built.get(index.name) ?? "";
      for (const part of parts) {
        expect(catalog, index.name).to.contain(part);
      }
    }
    expect(built.get("sku__g")).to.not.contain("_instance");
    if (GetDialect().session.multiValuedIndex) {
      expect(built.get("tags")).to.match(/as char\(512\) array/);
    }
  });

  it("serves an equality on a key column named in the query from its index", async () => {
    const lookups: [string, Sql][] = [
      ["price", sql`${scoped} price = 7`],
      ["sku", sql`${scoped} ${KeyColumnOf(schemaId, "sku")} = 'sku-7'`],
      ["sku__g", sql`${KeyColumnOf(schemaId, "sku__g")} = 'sku-7'`],
      [
        "titleFr",
        sql`${scoped} ${ValueKeyEquals(schemaId, "titleFr", "string", "titre 7")}`,
      ],
      [
        "color",
        sql`${scoped} ${ValueKeyEquals(schemaId, "color", "string", "color-7")}`,
      ],
      [
        "owner",
        sql`${scoped} ${ValueKeyEquals(schemaId, "owner", "string", "owner-7")}`,
      ],
      [
        "wholeTitle",
        sql`${scoped} ${ValueKeyEquals(schemaId, "wholeTitle", "object", '{"en": "title 7", "fr": "titre 7"}')}`,
      ],
    ];
    if (GetDialect().session.multiValuedIndex) {
      lookups.push([
        "tags",
        sql`${scoped} 'tag-7' MEMBER OF (JSON_EXTRACT(tags, '$'))`,
      ]);
    }
    for (const [index, condition] of lookups) {
      expect(await IndexUsed(schemaId, condition), index).to.equal(index);
    }
  });

  it("holds the value its key column reads, so the index finds the row the field names", async () => {
    const rows = await Read(
      sql`SELECT _id FROM ${ident(PhysicalTable(schemaId))} FORCE INDEX (owner) WHERE ${scoped} ${ValueKeyEquals(schemaId, "owner", "string", "owner-7")}`,
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
    await Run(Seed(ident(PhysicalTable(schemaId)), "alpha"));
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
      `_instance | price | ${Planned(schemaId, "price").parts.flatMap(PartColumns)[2]}`,
    );
  });

  it("leaves a unique index it cannot build to the next registration, and builds the rest", async () => {
    const schemaId = "indexes_refused";
    await Reset(schemaId);
    await Register(schemaId, BARE);
    await Run(Seed(ident(PhysicalTable(schemaId)), "alpha"));
    await Run(
      sql`UPDATE ${ident(PhysicalTable(schemaId))} SET price = 1 WHERE _id IN ('alpha-1', 'alpha-2')`,
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
    expect(warnings[0]).to.match(
      /could not build unique index 'price': Duplicate entry/,
    );
    expect((await Catalog(schemaId)).map((index) => index.name)).to.deep.equal([
      "sku",
    ]);
  });
});

/** Fields no declaration types, each keyed by a value key of two columns. */
function Undeclared(count: number): string[] {
  return Array.from({ length: count }, (_, position) => `u${position}`);
}

/** Seven fields of no declared type take 15 key columns with the instance, eight take 17, past MySQL's 16. */
const WIDE: SchemaDefinition = {
  items: {
    fields: FIELDS,
    indexes: {
      fits: { fields: Undeclared(7) },
      wide: { fields: Undeclared(8) },
      wideUnique: { fields: Undeclared(8), unique: true },
    },
  },
};

describe("an index over more key columns than MySQL allows in one index", function () {
  this.timeout(60_000);
  const schemaId = "indexes_wide";

  after(() => {
    Schemas.unregister(schemaId);
  });

  it("is left out with a warning that names it, while its table and the indexes that fit are built", async () => {
    await Reset(schemaId);
    const warnings = await CaptureWarnings(() => Register(schemaId, WIDE));
    expect(warnings).to.have.length(2);
    expect(warnings[0]).to.match(
      /^Index 'wide' on 'indexes_wide.items' is not built: it needs 17 key columns/,
    );
    expect(warnings[1]).to.match(
      /^Index 'wideUnique' on 'indexes_wide.items' is not built: .*nothing refuses a duplicate/,
    );
    expect((await Catalog(schemaId)).map((index) => index.name)).to.deep.equal([
      "fits",
    ]);
  });

  it("answers a getAll on the index left out from the rows themselves", async () => {
    const values = Undeclared(8).map((_, position) => position);
    const row = Object.fromEntries(
      Undeclared(8).map((field, position) => [field, values[position]]),
    );
    const items = new Schema<{ items: { _id: string } }>(schemaId, WIDE)
      .instance()
      .table("items");
    await items.insert([
      { _id: "match", ...row },
      { _id: "other", ...row, u7: "7" },
    ]);
    const found = await items.getAll([values], "wide").run();
    expect(found.map((item) => item._id)).to.deep.equal(["match"]);
  });
});
