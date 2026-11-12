import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

import { ident, sql } from "../statement";
import { CHANGE_LOG } from "../implementations/database/registry";
import { Schemas } from "../implementations/database/schema";
import { Run } from "./tables";
import { Opened, Pause, QUIET_MS, type Row } from "./watch";

const SCHEMA_ID = "feeds-log";
const DEFINITION = { rows: { fields: { label: "string" }, indexes: {} } };

const logged = new Schema<{ rows: Row }>(SCHEMA_ID, DEFINITION);

describe("a change log dropped and created again", function () {
  this.timeout(30_000);

  /**
   * The events written before the drop went with the log. A clock that kept its epoch across the
   * new log would let the feed read on from its watermark and skip them without a signal.
   */
  it("ends an open feed with the loss instead of skipping what it had not read", async () => {
    const rows = logged.instance().table("rows");
    const feed = await Opened(rows, "probe");
    try {
      await rows.insert({ _id: "unread", label: "lost with the log" });
      await Pause(QUIET_MS);
      await Run(sql`DROP TABLE ${ident(CHANGE_LOG.log)}`);
      await Schemas.register(SCHEMA_ID, DEFINITION);
      await rows.insert({ _id: "after", label: "logged anew" });
      const failure = await feed.next().then(
        (step) => `delivered ${JSON.stringify(step.value)}`,
        (err: unknown) => String(err),
      );
      expect(failure).to.contain("the change log was recreated");
    } finally {
      await feed.return?.();
    }
  });
});
