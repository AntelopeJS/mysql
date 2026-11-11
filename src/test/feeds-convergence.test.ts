import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";
import type { Changes } from "@antelopejs/interface-database/common";

import { param, sql } from "../statement";
import { Read } from "../connection";
import { IsReaperRunning } from "../implementations/database/reaper";
import { PhysicalTable } from "./tables";
import { DeliveredRow, Opened, type Row } from "./watch";

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
