import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

import { Schemas } from "../implementations/database/schema";
import { Delivered, DeliveredRow, Opened, type Row } from "./watch";

const SCHEMA_ID = "feeds-declaration";
const UNDECLARED = { rows: { fields: { label: "string" }, indexes: {} } };
const DECLARED = {
  rows: { fields: { label: "string", size: "number" }, indexes: {} },
};

const watched = new Schema<{ rows: Row }>(SCHEMA_ID, UNDECLARED);

describe("a feed open while its table is declared again", function () {
  this.timeout(30_000);

  before(async () => {
    await Schemas.register(SCHEMA_ID, UNDECLARED);
  });

  /**
   * Declaring `size` moves its values out of `_extra` into a column of its own. A feed that kept
   * the declaration it opened with would read `_extra` alone, and lose `size` from every event.
   */
  it("reads a field declared since it opened from its column", async () => {
    const rows = watched.instance().table("rows");
    const feed = await Opened(rows, "declared");
    try {
      await rows.insert({ _id: "before", label: "undeclared", size: 3 });
      const before = await DeliveredRow(feed, "before");
      expect(before).to.have.nested.property("newValue.size", 3);
      await Schemas.register(SCHEMA_ID, DECLARED);
      await rows.insert({ _id: "after", label: "declared", size: 5 });
      await rows.get("before").update({ label: "changed" });
      const after = await DeliveredRow(feed, "after");
      expect(after).to.have.nested.property("newValue.size", 5);
      const changed = await DeliveredRow(feed, "before");
      expect(changed).to.have.nested.property("oldValue.size", 3);
      expect(changed).to.have.nested.property("newValue.size", 3);
    } finally {
      await feed.return?.();
    }
  });
});

const LOGGED_ID = "feeds-declaration-logged";
const logged = new Schema<{ rows: Row }>(LOGGED_ID, UNDECLARED);

describe("a feed reading events logged before a field was declared", function () {
  this.timeout(30_000);

  before(async () => {
    await Schemas.register(LOGGED_ID, UNDECLARED);
  });

  /**
   * Both events are logged while `size` sits in `_extra`, and read once it is declared. A feed that
   * read a declared field from its column alone would find no member for it, and drop `size` from
   * every document of both events.
   */
  it("keeps the field in those events' documents", async () => {
    const rows = logged.instance().table("rows");
    const feed = await Opened(rows, "logged");
    try {
      await rows.insert({ _id: "early", label: "x", size: 3 });
      await rows.get("early").update({ label: "y" });
      await Schemas.register(LOGGED_ID, DECLARED);
      const added = await Delivered(feed.next());
      expect(added.newValue).to.deep.equal({
        _id: "early",
        label: "x",
        size: 3,
      });
      const changed = await Delivered(feed.next());
      expect(changed.oldValue).to.deep.equal({
        _id: "early",
        label: "x",
        size: 3,
      });
      expect(changed.newValue).to.deep.equal({
        _id: "early",
        label: "y",
        size: 3,
      });
    } finally {
      await feed.return?.();
    }
  });
});
