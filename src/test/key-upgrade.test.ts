import { expect } from "chai";
import type { SchemaDefinition } from "@antelopejs/interface-database/schema";
import { Schema } from "@antelopejs/interface-database/schema";

import { GetDialect, Read } from "../connection";
import { type Sql, ident, int, lit, param, sql } from "../statement";
import type { KeyColumn } from "../implementations/database/paths";
import {
  GetTablePlan,
  Schemas,
  WaitForIndexes,
} from "../implementations/database/schema";
import { Compiled } from "./compiled";
import { PhysicalTable, Run } from "./tables";

const SCHEMA_ID = "key_upgrade";
const INSTANCE = "one";
const MATCH = "titre";

/** The shape a matching row has; the other rows hold the titles of {@link TITLES} instead. */
interface Item {
  _id: string;
  title: { fr: string };
  _internal: { data: { title: { fr: string } } };
}

const DEFINITION: SchemaDefinition = {
  items: {
    fields: { title: "object" },
    indexes: {
      titleFr: { fields: ["title.fr"] },
      headingFr: { fields: ["_internal.data.title.fr"] },
    },
  },
};

const schema = new Schema<{ items: Item }>(SCHEMA_ID, DEFINITION);

/**
 * Titles whose path either holds the matched string or stops short of it in each way a value can:
 * through an array, a null, a scalar, a missing key, or at a value of another kind.
 */
const TITLES = {
  match: { fr: MATCH },
  arrayAbove: [{ fr: MATCH }],
  nullAbove: null,
  scalarAbove: MATCH,
  missing: { en: MATCH },
  arrayAt: { fr: [MATCH] },
  numberAt: { fr: 7 },
  otherText: { fr: `${MATCH} 2` },
};

const ROWS = Object.entries(TITLES).map(([id, title]) => ({
  id,
  title: JSON.stringify(title),
  extra: JSON.stringify({ _internal: { data: { title } } }),
}));

function Table(): Sql {
  return ident(PhysicalTable(SCHEMA_ID));
}

function KeyColumns(): readonly KeyColumn[] {
  return GetTablePlan(SCHEMA_ID, "items").keyColumns;
}

/** The read a key column's expression made before this release: one member read per key. */
function ChainedRead(key: KeyColumn): Sql {
  const json = GetDialect().sql.json;
  return key.path.reduce(
    (document, segment) => json.member(document, segment),
    ident(key.source),
  );
}

/** The type a value key's column has: its text a `VARCHAR` of its width, its number a `DOUBLE`. */
function ColumnType(key: KeyColumn): Sql {
  return "fit" in key ? sql`VARCHAR(${int(key.fit.width)})` : sql`DOUBLE`;
}

/** Regenerates a key column with the chained read, as a table an earlier release made holds it. */
function Downgrade(key: KeyColumn): Sql {
  const { json, scalar } = GetDialect().sql;
  const read = json.key(key.read, ChainedRead(key));
  const value = "fit" in key ? scalar.left(read, key.fit.width) : read;
  return sql`ALTER TABLE ${Table()} MODIFY COLUMN ${ident(key.name)} ${ColumnType(key)} GENERATED ALWAYS AS (${value}) VIRTUAL COMMENT ${lit(key.definition)}`;
}

async function Generation(key: KeyColumn): Promise<string> {
  const [row] = await Read(
    sql`SELECT GENERATION_EXPRESSION AS expression FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${param(PhysicalTable(SCHEMA_ID))} AND COLUMN_NAME = ${param(key.name)}`,
  );
  return String(row.get("expression")).toLowerCase();
}

function Items() {
  return schema.instance(INSTANCE).table("items");
}

const QUERIES = {
  titleFr: () => Items().filter((row) => row.key("title").key("fr").eq(MATCH)),
  headingFr: () =>
    Items().filter((row) =>
      row.key("_internal").key("data").key("title").key("fr").eq(MATCH),
    ),
};

describe("a key column an earlier release generated with one member read per key", function () {
  this.timeout(60_000);
  const downgraded = new Map<string, string>();

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    for (const row of ROWS) {
      await Run(
        sql`INSERT INTO ${Table()} (_id, _instance, title, _extra) VALUES (${param(row.id)}, ${param(INSTANCE)}, ${GetDialect().sql.json.parse(param(row.title))}, ${GetDialect().sql.json.parse(param(row.extra))})`,
      );
    }
    for (const key of KeyColumns()) {
      await Run(Downgrade(key));
      downgraded.set(key.name, await Generation(key));
    }
    await Schemas.register(SCHEMA_ID, DEFINITION);
    await WaitForIndexes(SCHEMA_ID);
  });

  it("holds on every row what the one-step read of its path reads", async () => {
    const json = GetDialect().sql.json;
    for (const key of KeyColumns()) {
      const whole = json.member(ident(key.source), ...key.path);
      const differing = await Read(
        sql`SELECT _id FROM ${Table()} WHERE NOT ${json.same(ChainedRead(key), whole)}`,
      );
      expect(differing, key.definition).to.deep.equal([]);
    }
  });

  it("is left in place by the convergence of the same declaration", async () => {
    const deep = KeyColumns().filter((key) => key.path.length > 1);
    expect(deep.map((key) => key.read).sort()).to.deep.equal([
      "ranked-number",
      "ranked-text",
    ]);
    for (const key of deep) {
      expect(downgraded.get(key.name), key.read).to.include(
        "json_extract(json_extract(",
      );
    }
    for (const key of KeyColumns()) {
      expect(await Generation(key)).to.equal(downgraded.get(key.name));
    }
  });

  for (const [index, query] of Object.entries(QUERIES)) {
    it(`serves the one-step read through its index, with the rows the path holds the value on (${index})`, async () => {
      const [plan] = await Read(
        sql`EXPLAIN FORMAT=TRADITIONAL ${Compiled(query())}`,
      );
      expect(String(plan.get("possible_keys"))).to.include(index);
      const found = await query().run();
      expect(found.map((item) => item._id)).to.deep.equal(["match"]);
    });
  }
});
