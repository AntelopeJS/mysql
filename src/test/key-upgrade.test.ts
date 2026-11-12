import { expect } from "chai";
import type { SchemaDefinition } from "@antelopejs/interface-database/schema";
import { Schema } from "@antelopejs/interface-database/schema";

import { GetDialect, Read } from "../connection";
import { type Sql, ident, lit, param, sql } from "../statement";
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

/** Regenerates a key column with the chained read, as a table an earlier release made holds it. */
function Downgrade(key: KeyColumn): Sql {
  const width = "fit" in key ? key.fit.width : 0;
  const { json, scalar } = GetDialect().sql;
  const value = scalar.left(json.key(key.read, ChainedRead(key)), width);
  return sql`ALTER TABLE ${Table()} MODIFY COLUMN ${ident(key.name)} VARCHAR(${param(width)}) GENERATED ALWAYS AS (${value}) VIRTUAL COMMENT ${lit(key.definition)}`;
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
        sql`INSERT INTO ${Table()} (_id, _instance, title, _extra) VALUES (${param(row.id)}, ${param(INSTANCE)}, CAST(${param(row.title)} AS JSON), CAST(${param(row.extra)} AS JSON))`,
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
        sql`SELECT _id FROM ${Table()} WHERE NOT (${ChainedRead(key)} <=> ${whole})`,
      );
      expect(differing, key.definition).to.deep.equal([]);
    }
  });

  it("is left in place by the convergence of the same declaration", async () => {
    const deep = KeyColumns().filter((key) => key.path.length > 1);
    expect(deep.map((key) => downgraded.get(key.name))).to.satisfy(
      (expressions: string[]) =>
        expressions.length === 1 &&
        expressions[0].includes("json_extract(json_extract("),
    );
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
