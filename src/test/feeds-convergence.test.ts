import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";
import type { Changes } from "@antelopejs/interface-database/common";

import { param, sql } from "../statement";
import { Read } from "../connection";
import { IsReaperRunning } from "../implementations/database/reaper";
import { RegisterElsewhere } from "./elsewhere";
import { PhysicalTable } from "./tables";
import { Delivered as Next, DeliveredRow, Opened, type Row } from "./watch";

const SCHEMA_ID = "feeds-swap";

const NARROW = {
  items: { fields: { name: "string" }, indexes: {} },
  others: { fields: { name: "string" }, indexes: {} },
} as const;

const WIDE = {
  items: { fields: { name: "string", size: "number" }, indexes: {} },
  others: { fields: { name: "string", size: "number" }, indexes: {} },
} as const;

async function Triggers(tableId: string): Promise<string[]> {
  const rows = await Read(
    sql`SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ${param(PhysicalTable(SCHEMA_ID, tableId))} ORDER BY TRIGGER_NAME`,
  );
  return rows.map((row) => String(row.get("name")));
}

/** Opens a feed on `items`, inserts `row`, and answers the event the feed delivers for it. */
async function Delivered(
  schema: Schema<{ items: Row; others: Row }>,
  row: Row,
): Promise<Changes<Row>> {
  const items = schema.instance().table("items");
  const feed = await Opened(items, `probe-${row._id}`);
  try {
    await items.insert(row);
    return await DeliveredRow(feed, row._id);
  } finally {
    await feed.return?.();
  }
}

describe("a watched table across convergence", function () {
  this.timeout(30_000);

  it("runs the reaper in an owned instance", () => {
    expect(IsReaperRunning()).to.equal(true);
  });

  it("swaps a watched table's triggers for ones that log a column added later, leaving an unwatched table without any", async () => {
    const narrow = new Schema<{ items: Row; others: Row }>(SCHEMA_ID, NARROW);
    expect(
      await Delivered(narrow, { _id: "a", name: "a" }),
    ).to.have.nested.property("newValue.name", "a");
    const before = await Triggers("items");
    expect(before).to.have.length(3);
    const wide = new Schema<{ items: Row; others: Row }>(SCHEMA_ID, WIDE);
    const change = await Delivered(wide, { _id: "b", name: "b", size: 3 });
    expect(change).to.have.nested.property("newValue.size", 3);
    const after = await Triggers("items");
    expect(after).to.have.length(3);
    expect(after.filter((name) => before.includes(name))).to.deep.equal([]);
    expect(await Triggers("others")).to.deep.equal([]);
  });
});

describe("a watched table an older process converges", function () {
  this.timeout(60_000);
  const schemaId = "feeds-rolling";

  /**
   * An older replica restarting in a rolling deploy registers the schema without `size`. Triggers
   * planned from its declaration would log the table without the column, and the newer process's
   * feed would deliver rows without the value it reads back.
   */
  it("keeps logging the column a newer process declared", async () => {
    const wide = new Schema<{ rows: Row }>(schemaId, {
      rows: { fields: { label: "string", size: "number" }, indexes: {} },
    });
    const rows = wide.instance().table("rows");
    const feed = await Opened(rows, "probe");
    try {
      const older = await RegisterElsewhere(schemaId, "narrow");
      expect({ code: older.code, stderr: older.stderr }).to.deep.equal({
        code: 0,
        stderr: "",
      });
      await rows.insert({ _id: "sized", label: "x", size: 42 });
      const change = await DeliveredRow(feed, "sized");
      expect(change).to.have.nested.property("newValue.size", 42);
    } finally {
      await feed.return?.();
    }
  });
});

describe("a watched table whose undeclared field becomes a column", function () {
  this.timeout(60_000);
  const schemaId = "feeds-backfill";

  /**
   * The backfill moves each stored `size` out of `_extra` into the new column. A backfill whose
   * writes were logged would deliver one `modified` event per row, and the feed, which reads the
   * table as it was declared when it opened, would show `size` gone from each new value.
   */
  it("delivers nothing for the rows the backfill moved", async () => {
    const narrow = new Schema<{ items: Row }>(schemaId, {
      items: { fields: { name: "string" }, indexes: {} },
    });
    await narrow
      .instance()
      .table("items")
      .insert([
        { _id: "a", name: "a", size: 1 },
        { _id: "b", name: "b", size: 2 },
      ]);
    const feed = await Opened(narrow.instance().table("items"), "probe");
    try {
      const wide = new Schema<{ items: Row }>(schemaId, {
        items: { fields: { name: "string", size: "number" }, indexes: {} },
      });
      const items = wide.instance().table("items");
      await items.insert({ _id: "marker", name: "m" });
      expect(await Next(feed.next())).to.deep.equal({
        changeType: "added",
        newValue: { _id: "marker", name: "m" },
      });
      expect(await items.get("a")).to.deep.equal({
        _id: "a",
        name: "a",
        size: 1,
      });
    } finally {
      await feed.return?.();
    }
  });
});
