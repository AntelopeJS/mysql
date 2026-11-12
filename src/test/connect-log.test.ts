import { expect } from "chai";

import { sql } from "../statement";
import { Disconnect, Read } from "../connection";
import { GetOptions } from "../config";
import { Logger } from "../logger";
import { Reconnect } from "./tables";

async function LoggedInfo(work: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = Logger.Info.bind(Logger);
  Logger.Info = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await work();
  } finally {
    Logger.Info = original;
  }
  return lines;
}

async function ServerEngine(): Promise<string> {
  const [row] = await Read(sql`SELECT VERSION() AS version`);
  return /mariadb/i.test(String(row.get("version"))) ? "MariaDB" : "MySQL";
}

describe("the connection log", () => {
  it("names the engine the server reports when it connects and disconnects", async () => {
    const engine = await ServerEngine();
    const restore = GetOptions();
    const lines = await LoggedInfo(async () => {
      await Disconnect();
      await Reconnect(restore);
    });
    const connectionLines = lines.filter((line) =>
      /^(dis)?connected (to|from) /.test(line),
    );
    expect(connectionLines).to.deep.equal([
      `disconnected from ${engine}`,
      `connected to ${engine}`,
    ]);
  });
});
