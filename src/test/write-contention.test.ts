import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

import { ident, sql } from "../statement";
import { AcquireConnection } from "../connection";
import { WaitForSchemaReady } from "../implementations/database/schema";
import { Numbers, PhysicalTable, Run } from "./tables";
import { Pause } from "./watch";

interface Item {
  _id: string;
  n?: number;
}

const SCHEMA_ID = "write-contention";

/** Long enough for an update to reach the row lock it waits on. */
const LOCK_REACHED_MS = 300;

const contended = new Schema<{ items: Item }>(SCHEMA_ID, {
  items: { fields: { n: "number" }, indexes: {} },
});
const items = () => contended.instance().table("items");
const table = () => ident(PhysicalTable(SCHEMA_ID, "items"));

describe("writes that contend for rows", function () {
  this.timeout(60_000);

  beforeEach(async () => {
    await WaitForSchemaReady(SCHEMA_ID);
    await Run(sql`DELETE FROM ${table()}`);
    await Run(
      sql`INSERT INTO ${table()} (_id, _instance, n) SELECT LPAD(n, 4, '0'), '', n FROM ${Numbers(3)} AS numbers`,
    );
  });

  it("runs an update again when another transaction deadlocks it", async () => {
    const other = await AcquireConnection();
    try {
      await Run(sql`START TRANSACTION`, other);
      await Run(
        sql`UPDATE ${table()} SET n = n + 1 WHERE _instance = '' AND _id >= '0100'`,
        other,
      );
      const update = items()
        .getAll(["0000", "0500"])
        .update({ n: -1 })
        .run()
        .then(
          (count) => count,
          (err: unknown) => String(err),
        );
      await Pause(LOCK_REACHED_MS);
      await Run(
        sql`UPDATE ${table()} SET n = n + 1 WHERE _instance = '' AND _id = '0000'`,
        other,
      );
      await Run(sql`COMMIT`, other);
      expect(await update).to.equal(2);
    } finally {
      other.release();
    }
  });
});
