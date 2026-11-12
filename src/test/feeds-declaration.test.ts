import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

import { Schemas } from "../implementations/database/schema";
import { DeliveredRow, Opened, type Row } from "./watch";

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
