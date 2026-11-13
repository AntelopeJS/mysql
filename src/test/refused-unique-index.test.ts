import { expect } from "chai";
import { IsDuplicateKeyError } from "@antelopejs/interface-database";
import type { AtomicUpdate } from "@antelopejs/interface-database/atomic";
import {
  Schema,
  type SchemaDefinition,
} from "@antelopejs/interface-database/schema";

import { ident, param, sql } from "../statement";
import { Read } from "../connection";
import { Schemas, WaitForIndexes } from "../implementations/database/schema";
import { PhysicalTable, Run } from "./tables";

interface Item {
  _id?: string;
  sku?: string;
  price?: number;
}

const SCHEMA_ID = "refused_unique";
const FIELDS = { sku: "string", price: "number" } as const;
const BARE: SchemaDefinition = { items: { fields: FIELDS, indexes: {} } };
const UNIQUE_PRICE: SchemaDefinition = {
  items: { fields: FIELDS, indexes: { price: { unique: true } } },
};

/** An atomic update that moves `sku` on and sets nothing else. */
const REVISE_SKU: AtomicUpdate<Item> = {
  type: "update",
  revisionField: "sku",
  expectedRevision: "sku-c",
  nextRevision: "sku-c2",
  patch: {},
};

const schema = new Schema<{ items: Item }>(SCHEMA_ID, UNIQUE_PRICE);
const items = () => schema.instance().table("items");

async function IndexNames(): Promise<string[]> {
  const rows = await Read(
    sql`SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${param(PhysicalTable(SCHEMA_ID))} AND INDEX_NAME <> 'PRIMARY' ORDER BY INDEX_NAME`,
  );
  return rows.map((row) => String(row.get("name")));
}

type WriteOutcome = "stored" | Error;

/** The error a write threw, or `"stored"` when it went through. */
async function Outcome(write: PromiseLike<unknown>): Promise<WriteOutcome> {
  try {
    await write;
    return "stored";
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function ExpectRefusal(outcome: WriteOutcome): void {
  expect(outcome, "the write is refused").to.be.instanceOf(Error);
  const message = outcome === "stored" ? "" : outcome.message;
  expect(message).to.include(`unique index 'price' on '${SCHEMA_ID}.items'`);
  expect(message, "it names the server's reason").to.match(/Duplicate entry/);
}

describe("writes to a table whose unique index the server refused", function () {
  this.timeout(60_000);

  before(async () => {
    await Run(sql`DROP TABLE IF EXISTS ${ident(PhysicalTable(SCHEMA_ID))}`);
    await Schemas.register(SCHEMA_ID, BARE);
    await WaitForIndexes(SCHEMA_ID);
    await Run(
      sql`INSERT INTO ${ident(PhysicalTable(SCHEMA_ID))} (_id, _instance, sku, price) VALUES ('a', '', 'sku-a', 7), ('b', '', 'sku-b', 7), ('c', '', 'sku-c', 8)`,
    );
    await Schemas.register(SCHEMA_ID, UNIQUE_PRICE);
    await WaitForIndexes(SCHEMA_ID);
  });

  after(() => {
    Schemas.unregister(SCHEMA_ID);
  });

  it("is left unbuilt over the duplicates the table holds", async () => {
    expect(await IndexNames()).to.deep.equal([]);
  });

  it("refuses an insert, naming the index and the reason, and stores nothing", async () => {
    ExpectRefusal(await Outcome(items().insert({ _id: "d", price: 7 }).run()));
    expect(await items().get("d").run()).to.equal(undefined);
  });

  it("refuses an update or a replace that sets the indexed field", async () => {
    ExpectRefusal(await Outcome(items().get("c").update({ price: 7 }).run()));
    ExpectRefusal(
      await Outcome(items().get("c").replace({ sku: "sku-c", price: 8 }).run()),
    );
    ExpectRefusal(
      await Outcome(
        items()
          .atomicMutation("c", { ...REVISE_SKU, patch: { price: 7 } })
          .run(),
      ),
    );
    expect((await items().get("c").run())?.price).to.equal(8);
  });

  it("keeps reads, deletes and updates of other fields working", async () => {
    expect(await items().atomicMutation("c", REVISE_SKU).run()).to.equal(
      "applied",
    );
    expect(await items().get("c").update({ sku: "renamed" }).run()).to.equal(1);
    expect((await items().get("c").run())?.sku).to.equal("renamed");
    expect(await items().get("b").delete().run()).to.equal(1);
    expect(await items().get("b").run()).to.equal(undefined);
  });

  it("is built once the duplicates are gone and the schema registers again, and refuses the next duplicate", async () => {
    await Schemas.register(SCHEMA_ID, UNIQUE_PRICE);
    await WaitForIndexes(SCHEMA_ID);
    expect(await IndexNames()).to.deep.equal(["price"]);
    expect(
      await Outcome(items().insert({ _id: "d", price: 9 }).run()),
    ).to.equal("stored");
    const duplicate = await Outcome(
      items().insert({ _id: "e", price: 7 }).run(),
    );
    expect(IsDuplicateKeyError(duplicate), String(duplicate)).to.equal(true);
  });
});
