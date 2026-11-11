import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

import { Read } from "../connection";
import { type Sql, ident, sql } from "../statement";
import { WaitForIndexes } from "../implementations/database/schema";
import { Compiled } from "./compiled";
import { PhysicalTable, Run } from "./tables";

const SCHEMA_ID = "includes_index";
const INSTANCE = "one";
const ROWS = 1500;

interface Item {
  _id: string;
  tags: string[];
}

const schema = new Schema<{ items: Item }>(SCHEMA_ID, {
  items: {
    fields: { tags: "string[]" },
    indexes: { tags: { multi: true } },
  },
});

function Items() {
  return schema.instance(INSTANCE).table("items");
}

const USED_KEY_PARTS = /"(?:used_key_parts|key_columns)":\s*\[[^\]]*\]/g;

/**
 * The key parts the server's plan for `statement` reads, as the plan spells them: `used_key_parts`
 * in MySQL 8.4's plan, and `key_columns` in the plan of 9.7.
 */
async function KeyPartsUsed(statement: Sql): Promise<string[]> {
  const [row] = await Read(sql`EXPLAIN FORMAT=JSON ${statement}`);
  const text = row.get("EXPLAIN");
  return String(text).match(USED_KEY_PARTS) ?? [];
}

const ELEMENTS_PART = /as char\(512\) array/;

describe("a membership test on a column with a multi-valued index", function () {
  this.timeout(60_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Items()
      .insert(
        Array.from({ length: ROWS }, (_, n) => ({
          _id: `i${n}`,
          tags: [`tag-${n}`, `tag-${n + 1}`],
        })),
      )
      .run();
    await WaitForIndexes(SCHEMA_ID);
    await Run(sql`ANALYZE TABLE ${ident(PhysicalTable(SCHEMA_ID))}`);
  });

  it("reads the index's elements for `includes`, and finds the same rows", async () => {
    const query = Items().filter((row) => row.key("tags").includes("tag-7"));
    const parts = await KeyPartsUsed(Compiled(query));
    expect(parts.filter((part) => ELEMENTS_PART.test(part))).to.have.length(1);
    const found = await query.run();
    expect(found.map((item) => item._id).sort()).to.deep.equal(["i6", "i7"]);
  });

  it("reads the index's elements for a key looked up in a `multi` index", async () => {
    const query = Items().getAll("tag-7", "tags");
    const parts = await KeyPartsUsed(Compiled(query));
    expect(parts.filter((part) => ELEMENTS_PART.test(part))).to.have.length(1);
    const found = await query.run();
    expect(found.map((item) => item._id).sort()).to.deep.equal(["i6", "i7"]);
  });
});
