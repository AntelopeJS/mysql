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
});
