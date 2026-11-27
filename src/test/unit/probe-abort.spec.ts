import { expect } from "chai";

import { probe } from "../../probe";
import { CLOSE_SETTLE_MS, SilentServer, TIMEOUT_MS } from "./probe-fixture";

const ABORTED = { outcome: "unreachable", message: "The probe was aborted." };

function UrlOf(port: number): string {
  return `mysql://reader:secret@127.0.0.1:${port}/shop`;
}

describe("probe, once its signal aborts", function () {
  this.timeout(TIMEOUT_MS * 5);

  it("answers at once and shuts its socket when the signal aborts", async () => {
    const server = await SilentServer();
    const controller = new AbortController();
    try {
      const pending = probe({
        url: UrlOf(server.port),
        timeoutMs: TIMEOUT_MS * 10,
        signal: controller.signal,
      });
      const started = performance.now();
      setTimeout(() => controller.abort(), TIMEOUT_MS / 10);
      const answer = await pending;
      expect(performance.now() - started).to.be.lessThan(TIMEOUT_MS);
      expect(answer).to.deep.equal(ABORTED);
      expect(await server.openAfter(CLOSE_SETTLE_MS)).to.equal(0);
    } finally {
      await server.close();
    }
  });

  it("opens nothing for a signal that has already aborted", async () => {
    const server = await SilentServer();
    try {
      const answer = await probe({
        url: UrlOf(server.port),
        timeoutMs: TIMEOUT_MS,
        signal: AbortSignal.abort(),
      });
      expect(answer).to.deep.equal(ABORTED);
      expect(await server.openAfter(TIMEOUT_MS / 10)).to.equal(0);
      expect(server.accepted()).to.equal(0);
    } finally {
      await server.close();
    }
  });
});
