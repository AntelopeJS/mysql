import { expect } from "chai";

import { sql } from "../statement";
import { Read } from "../connection";
import { RegisterElsewhere } from "./elsewhere";

const SCHEMA_ID = "connect-log";

const CONNECTION_LINE = /^(dis)?connected (to|from) /;

async function ServerEngine(): Promise<string> {
  const [row] = await Read(sql`SELECT VERSION() AS version`);
  return /mariadb/i.test(String(row.get("version"))) ? "MariaDB" : "MySQL";
}

describe("the connection log", function () {
  this.timeout(60_000);

  it("names the engine the server reports when a module instance connects and disconnects", async () => {
    const engine = await ServerEngine();
    const exit = await RegisterElsewhere(SCHEMA_ID, "narrow");
    expect(exit.code, exit.stderr).to.equal(0);
    expect(
      exit.logged.filter((line) => CONNECTION_LINE.test(line)),
    ).to.deep.equal([`connected to ${engine}`, `disconnected from ${engine}`]);
  });
});
