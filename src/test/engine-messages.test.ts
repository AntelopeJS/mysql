import { expect } from "chai";

import { type Options, GetOptions } from "../config";
import { AcquireConnection, Disconnect, Read } from "../connection";
import { Logger } from "../logger";
import { int, sql } from "../statement";
import { Reconnect, Run } from "./tables";

const SLOW_ACQUIRE_MS = 10_000;

const SETTLE_MS = 200;

async function ServerEngine(): Promise<string> {
  const [row] = await Read(sql`SELECT VERSION() AS version`);
  return /mariadb/i.test(String(row.get("version"))) ? "MariaDB" : "MySQL";
}

/** Collects the warnings logged until the answered function is called, which answers them. */
function CollectWarnings(): () => string[] {
  const warnings: string[] = [];
  const original = Logger.Warn.bind(Logger);
  Logger.Warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  return () => {
    Logger.Warn = original;
    return warnings;
  };
}

function Delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Each line cut to the length of `start`, so a list of them includes `start` when a line begins with it. */
function Openings(lines: string[], start: string): string[] {
  return lines.map((line) => line.slice(0, start.length));
}

async function Refusal<T>(work: () => PromiseLike<T>): Promise<string> {
  try {
    await work();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return err.message;
  }
  throw new Error("the call was expected to be refused");
}

describe("the connection's warnings and refusals", function () {
  this.timeout(60_000);
  let original: Options;
  let engine: string;

  before(async () => {
    const { url, pool, statementTimeoutMs } = GetOptions();
    original = { url, pool, statementTimeoutMs };
    engine = await ServerEngine();
  });

  after(async () => {
    await Reconnect(original);
  });

  it("names the connected engine when a pooled connection is killed", async () => {
    const victim = await AcquireConnection();
    const [row] = await Read(sql`SELECT CONNECTION_ID() AS id`, victim);
    const stop = CollectWarnings();
    await Run(sql`KILL ${int(Number(row.get("id")))}`);
    await Delay(SETTLE_MS);
    victim.destroy();
    const failed = `a pooled ${engine} connection failed`;
    expect(Openings(stop(), failed)).to.include(failed);
  });

  it("names the connected engine when no connection becomes available", async () => {
    await Reconnect({ ...original, pool: { connectionLimit: 1 } });
    const held = await AcquireConnection();
    const stop = CollectWarnings();
    const waiting = AcquireConnection();
    await Delay(SLOW_ACQUIRE_MS + SETTLE_MS);
    held.release();
    (await waiting).release();
    const slow = `no ${engine} connection has become available in`;
    expect(Openings(stop(), slow)).to.include(slow);
  });

  it("names either engine when no server has been reached", async () => {
    await Disconnect();
    expect(await Refusal(() => Read(sql`SELECT 1`))).to.equal(
      "MySQL or MariaDB adapter is not connected: construct() has not run yet",
    );
  });
});
