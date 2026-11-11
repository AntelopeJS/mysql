import { expect } from "chai";

import { sql } from "../statement";
import { Read } from "../connection";

describe("an external instance at startup", () => {
  it("creates no bookkeeping table in the client's database", async () => {
    const rows = await Read(
      sql`SELECT COUNT(*) AS tables FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE '\\_\\_antelope%'`,
    );
    expect(rows.map((row) => Number(row.get("tables")))).to.deep.equal([0]);
  });
});
