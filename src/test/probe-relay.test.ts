import { expect } from "chai";

import { GetOptions } from "../config";
import { probe } from "../probe";
import {
  CLOSE_SETTLE_MS,
  Commands,
  PREPARE_COMMAND,
  QUIT_COMMAND,
  RefuseNthPrepare,
  Relay,
  TIMEOUT_MS,
  Unaborted,
  WatchClientSockets,
} from "./unit/probe-fixture";

/** `ER_TABLEACCESS_DENIED_ERROR`. */
const TABLE_ACCESS_DENIED = 1142;

describe("probe, through a relay to a live server", function () {
  this.timeout(30_000);
  const admin = new URL(GetOptions().url ?? "");
  const host = admin.hostname;
  const port = Number(admin.port || 3306);

  /** The module's own account, through a relay on `relayPort`. */
  function Through(relayPort: number): string {
    const url = new URL(admin);
    url.port = String(relayPort);
    return url.toString();
  }

  function Probe(url: string) {
    return probe({ url, timeoutMs: TIMEOUT_MS, signal: Unaborted() });
  }

  /** Fails on a probe that answers a server error after the sign-in as a refused sign-in. */
  it("answers that it cannot list the relations when the server refuses the listing after the sign-in", async () => {
    const relay = await Relay(host, port, {
      answer: RefuseNthPrepare(2, TABLE_ACCESS_DENIED, "SELECT command denied"),
    });
    try {
      expect(await Probe(Through(relay.port))).to.deep.include({
        outcome: "signed-in",
        canRead: false,
        canWrite: false,
        unreadable: "cannot-list",
      });
    } finally {
      await relay.close();
    }
  });

  /** Fails on a probe that leaves its connection open once it has answered. */
  it("closes its connection once it has answered", async () => {
    const relay = await Relay(host, port);
    try {
      const answer = await Probe(Through(relay.port));
      expect(answer.outcome).to.equal("signed-in");
      expect(await relay.openAfter(CLOSE_SETTLE_MS)).to.equal(0);
    } finally {
      await relay.close();
    }
  });

  /** Fails on a probe that trusts `mysql2`'s `end` to have closed the socket. */
  it("answers, and shuts its socket, when the server ignores the goodbye", async () => {
    const relay = await Relay(host, port, {
      stall: Commands(QUIT_COMMAND),
      ignoresGoodbye: true,
    });
    const sockets = WatchClientSockets(relay.port);
    try {
      const answer = await Probe(Through(relay.port));
      expect(answer.outcome).to.equal("signed-in");
      expect(await sockets.leftOpenAfter(CLOSE_SETTLE_MS)).to.equal(0);
    } finally {
      sockets.stop();
      await relay.close();
    }
  });

  /** Fails on a probe whose statements after the sign-in wait without bound. */
  it("answers unreachable, and shuts its socket, when the server stops answering after the sign-in", async () => {
    const relay = await Relay(host, port, { stall: Commands(PREPARE_COMMAND) });
    const sockets = WatchClientSockets(relay.port);
    try {
      const started = performance.now();
      const answer = await Probe(Through(relay.port));
      expect(performance.now() - started).to.be.lessThan(TIMEOUT_MS * 2);
      expect(answer.outcome).to.equal("unreachable");
      expect(await sockets.leftOpenAfter(CLOSE_SETTLE_MS)).to.equal(0);
    } finally {
      sockets.stop();
      await relay.close();
    }
  });

  /** Fails on a probe that keeps what the server answered, or its socket, once the signal aborts. */
  it("answers aborted at once, and shuts its socket, when the signal aborts after the sign-in", async () => {
    const relay = await Relay(host, port, { stall: Commands(PREPARE_COMMAND) });
    const sockets = WatchClientSockets(relay.port);
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
      expect(await sockets.leftOpenAfter(CLOSE_SETTLE_MS)).to.equal(0);
    } finally {
      sockets.stop();
      await relay.close();
    }
  });
});
