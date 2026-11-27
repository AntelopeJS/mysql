import { expect } from "chai";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GetOptions } from "../config";
import { probe } from "../probe";
import {
  type Answer,
  Commands,
  EXECUTE_COMMAND,
  Frame,
  QUERY_COMMAND,
  Relay,
  TIMEOUT_MS,
  Unaborted,
} from "./unit/probe-fixture";

const SECRET = `local-${randomBytes(6).toString("hex")}`;

/** The answer by which a server asks the client for the content of a local file, `LOAD DATA LOCAL INFILE`. */
const LOCAL_INFILE = 0xfb;

/**
 * Answers the first `command` the client sends with a request for the local file `file`, then
 * keeps every later chunk from the server, in `sent`.
 */
function AsksForFile(command: number, file: string, sent: Buffer[]): Answer {
  const isCommand = Commands(command);
  let asked = false;
  return (chunk) => {
    if (asked) {
      sent.push(chunk);
      return Buffer.alloc(0);
    }
    if (!isCommand(chunk, true)) {
      return undefined;
    }
    asked = true;
    return Frame(
      1,
      Buffer.concat([Buffer.from([LOCAL_INFILE]), Buffer.from(file)]),
    );
  };
}

describe("probe, against a server that asks for a local file", function () {
  this.timeout(30_000);
  const admin = new URL(GetOptions().url ?? "");
  let directory: string;
  let file: string;

  before(async () => {
    directory = await mkdtemp(
      path.join(os.tmpdir(), "ajs-mysql-probe-infile-"),
    );
    file = path.join(directory, "secret.txt");
    await writeFile(file, SECRET);
  });

  after(() => rm(directory, { recursive: true, force: true }));

  for (const [step, command] of [
    ["the account's query", QUERY_COMMAND],
    ["the listing", EXECUTE_COMMAND],
  ] as const) {
    it(`sends no local file the server asks for in answer to ${step}`, async () => {
      const sent: Buffer[] = [];
      const relay = await Relay(admin.hostname, Number(admin.port || 3306), {
        answer: AsksForFile(command, file, sent),
      });
      try {
        const url = new URL(admin);
        url.port = String(relay.port);
        const answer = await probe({
          url: url.toString(),
          timeoutMs: TIMEOUT_MS,
          signal: Unaborted(),
        });
        expect(Buffer.concat(sent).toString("latin1")).to.not.include(SECRET);
        expect(answer.outcome).to.not.equal("signed-in");
      } finally {
        await relay.close();
      }
    });
  }
});
