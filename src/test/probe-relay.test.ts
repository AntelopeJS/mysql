import { expect } from "chai";

import { GetOptions } from "../config";
import { probe } from "../probe";
import {
  CLOSE_SETTLE_MS,
  CommandCounter,
  Commands,
  PREPARE_COMMAND,
  QUIT_COMMAND,
  RefuseNthPrepare,
  Relay,
  TIMEOUT_MS,
  Unaborted,
} from "./unit/probe-fixture";

/** The statement the probe prepares first: the listing of the relations, after the account's query. */
const LISTING = 1;

/** `ER_TABLEACCESS_DENIED_ERROR`. */
const TABLE_ACCESS_DENIED = 1142;

describe("probe, through a relay to a live server", function () {
  this.timeout(30_000);
  const admin = new URL(GetOptions().url ?? "");
  const host = admin.hostname;
  const port = Number(admin.port || 3306);

  function Through(relayPort: number): string {
    const url = new URL(admin);
    url.port = String(relayPort);
    return url.toString();
  }

  function Probe(url: string) {
    return probe({ url, timeoutMs: TIMEOUT_MS, signal: Unaborted() });
  }

  it("answers that it cannot list the relations when the server refuses the listing after the sign-in", async () => {
    const relay = await Relay(host, port, {
      answer: RefuseNthPrepare(
        LISTING,
        TABLE_ACCESS_DENIED,
        "SELECT command denied",
      ),
    });
    try {
      const answer = await Probe(Through(relay.port));
      expect(answer).to.deep.include({
        outcome: "signed-in",
        canRead: false,
        canWrite: false,
        unreadable: "cannot-list",
      });
      expect(answer).to.have.property("latencyMs").that.is.above(0);
      expect(answer)
        .to.have.property("user")
        .that.satisfies((user: string) =>
          user.startsWith(`${decodeURIComponent(admin.username)}@`),
        );
    } finally {
      await relay.close();
    }
  });

  it("says goodbye and closes its connection once it has answered", async () => {
    const quits = CommandCounter(QUIT_COMMAND);
    const relay = await Relay(host, port, { answer: quits.answer });
    try {
      const answer = await Probe(Through(relay.port));
      expect(answer.outcome).to.equal("signed-in");
      expect(await relay.openAfter(CLOSE_SETTLE_MS)).to.equal(0);
      expect(quits.count()).to.equal(1);
    } finally {
      await relay.close();
    }
  });

  it("answers, and shuts its socket, when the server ignores the goodbye", async () => {
    const relay = await Relay(host, port, {
      stall: Commands(QUIT_COMMAND),
      ignoresGoodbye: true,
    });
    try {
      const answer = await Probe(Through(relay.port));
      expect(answer.outcome).to.equal("signed-in");
      expect(await relay.openAfter(CLOSE_SETTLE_MS)).to.equal(0);
    } finally {
      await relay.close();
    }
  });

  it("answers aborted at once, and shuts its socket, when the signal aborts after the sign-in", async () => {
    const relay = await Relay(host, port, { stall: Commands(PREPARE_COMMAND) });
    const controller = new AbortController();
    try {
      const pending = probe({
        url: Through(relay.port),
        timeoutMs: TIMEOUT_MS * 10,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), TIMEOUT_MS / 2);
      const started = performance.now();
      expect(await pending).to.deep.equal({
        outcome: "unreachable",
        message: "The probe was aborted.",
      });
      expect(performance.now() - started).to.be.lessThan(TIMEOUT_MS);
      expect(await relay.openAfter(TIMEOUT_MS / 2)).to.equal(0);
    } finally {
      await relay.close();
    }
  });
});
