import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

import { DeliveredRow, OpenedOver, type Row } from "./watch";

const chained = new Schema<{ rows: Row }>("feeds-merge-map", {
  rows: { fields: { label: "string" }, indexes: {} },
});

/**
 * MariaDB 11.8 failed the feed's poll with an unknown `ev.new_row` in `JSON_TABLE` when a second
 * merge stage read the row the first one merged, and the feed retried it forever without
 * delivering; a feed that delivers the first stage's row alone answers without `o`.
 */
describe("a change feed over two chained merge maps", function () {
  this.timeout(30_000);

  it("delivers each event through both merges", async () => {
    const rows = chained.instance().table("rows");
    const feed = await OpenedOver(
      rows
        .map((row) => row.merge({ m: "x" }))
        .map((row) => row.merge({ o: "y" }))
        .changes()
        .cursor(),
      rows,
      { _id: "probe" },
    );
    try {
      await rows.insert({ _id: "first", label: "a" }).run();
      await rows.insert({ _id: "second", label: "b" }).run();
      expect((await DeliveredRow(feed, "first")).newValue).to.deep.equal({
        _id: "first",
        label: "a",
        m: "x",
        o: "y",
      });
      expect((await DeliveredRow(feed, "second")).newValue).to.deep.equal({
        _id: "second",
        label: "b",
        m: "x",
        o: "y",
      });
    } finally {
      await feed.return?.();
    }
  });

  /**
   * The second merge wrapped the filtered side, so an update that took the row out of the filter
   * left that side without a row and was delivered with a null `newValue`, and one that brought it
   * back with a null `oldValue`.
   */
  it("delivers both documents of updates that leave and re-enter the filter", async () => {
    const rows = chained.instance().table("rows");
    const feed = await OpenedOver(
      rows
        .filter((row) => row.key("label").eq("keep"))
        .map((row) => row.merge({ m: "x" }))
        .map((row) => row.merge({ o: "y" }))
        .changes()
        .cursor(),
      rows,
      { _id: "leave-probe", label: "keep" },
    );
    try {
      await rows.insert({ _id: "leaving", label: "keep" }).run();
      await DeliveredRow(feed, "leaving");
      await rows.get("leaving").update({ label: "gone" }).run();
      const left = await DeliveredRow(feed, "leaving");
      expect(left).to.deep.include({
        changeType: "modified",
        oldValue: { _id: "leaving", label: "keep", m: "x", o: "y" },
        newValue: { _id: "leaving", label: "gone", m: "x", o: "y" },
      });
      await rows.get("leaving").update({ label: "keep" }).run();
      const entered = await DeliveredRow(feed, "leaving");
      expect(entered).to.deep.include({
        changeType: "modified",
        oldValue: { _id: "leaving", label: "gone", m: "x", o: "y" },
        newValue: { _id: "leaving", label: "keep", m: "x", o: "y" },
      });
    } finally {
      await feed.return?.();
    }
  });
});
