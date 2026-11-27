import { expect } from "chai";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { probe } from "../../probe";
import {
  ClosedPort,
  CLOSE_SETTLE_MS,
  LocalSocketPath,
  RefusingServer,
  SilentServer,
  TIMEOUT_MS,
  Unaborted,
} from "./probe-fixture";

const HOST_NOT_PRIVILEGED = 1130;
const TOO_MANY_CONNECTIONS = 1040;
const NOT_ALLOWED = "Host '127.0.0.1' is not allowed to connect to this server";

function UrlOf(port: number, query = ""): string {
  return `mysql://reader:secret@127.0.0.1:${port}/shop${query}`;
}

describe("probe, against servers that never sign in", function () {
  this.timeout(TIMEOUT_MS * 5);

  it("answers a server that turns the client's host away as a refusal of the host", async () => {
    const server = await RefusingServer(HOST_NOT_PRIVILEGED, NOT_ALLOWED);
    try {
      const answer = await probe({
        url: UrlOf(server.port),
        timeoutMs: TIMEOUT_MS,
        signal: Unaborted(),
      });
      expect(answer).to.deep.equal({
        outcome: "refused",
        refusal: "host",
        message: NOT_ALLOWED,
      });
    } finally {
      await server.close();
    }
  });

  it("answers any other error the server refuses with as another refusal", async () => {
    const server = await RefusingServer(
      TOO_MANY_CONNECTIONS,
      "Too many connections",
    );
    try {
      const answer = await probe({
        url: UrlOf(server.port),
        timeoutMs: TIMEOUT_MS,
        signal: Unaborted(),
      });
      expect(answer).to.include({ outcome: "refused", refusal: "other" });
    } finally {
      await server.close();
    }
  });

  it("connects to the socket path the URL names, not to its host and port", async () => {
    const socketPath = LocalSocketPath();
    const server = await RefusingServer(
      HOST_NOT_PRIVILEGED,
      NOT_ALLOWED,
      socketPath,
    );
    try {
      const answer = await probe({
        url: UrlOf(
          await ClosedPort(),
          `?socketPath=${encodeURIComponent(socketPath)}`,
        ),
        timeoutMs: TIMEOUT_MS,
        signal: Unaborted(),
      });
      expect(answer).to.include({ outcome: "refused", refusal: "host" });
      expect(server.accepted()).to.equal(1);
    } finally {
      await server.close();
    }
  });

  it("answers a port nothing listens on as unreachable", async () => {
    const answer = await probe({
      url: UrlOf(await ClosedPort()),
      timeoutMs: TIMEOUT_MS,
      signal: Unaborted(),
    });
    expect(answer.outcome).to.equal("unreachable");
  });

  it("answers a port nothing listens on at localhost with what failed", async () => {
    const answer = await probe({
      url: `mysql://reader:secret@localhost:${await ClosedPort()}/shop`,
      timeoutMs: TIMEOUT_MS,
      signal: Unaborted(),
    });
    expect(answer.outcome).to.equal("unreachable");
    expect(answer).to.have.property("message").that.has.length.above(0);
  });

  it("answers a URL the driver cannot read as unreachable, without rejecting", async () => {
    const answer = await probe({
      url: "mysql://[::1",
      timeoutMs: TIMEOUT_MS,
      signal: Unaborted(),
    });
    expect(answer.outcome).to.equal("unreachable");
  });

  it("answers a server that never speaks as unreachable within the timeout, and shuts its socket", async () => {
    const server = await SilentServer();
    try {
      const started = performance.now();
      const answer = await probe({
        url: UrlOf(server.port),
        timeoutMs: TIMEOUT_MS,
        signal: Unaborted(),
      });
      expect(performance.now() - started).to.be.lessThan(TIMEOUT_MS * 2);
      expect(answer.outcome).to.equal("unreachable");
      expect(await server.openAfter(CLOSE_SETTLE_MS)).to.equal(0);
    } finally {
      await server.close();
    }
  });
});

describe("probe, at socket paths nothing answers at", function () {
  this.timeout(TIMEOUT_MS * 5);

  it("answers the same message for every socket path nothing answers at", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "ajs-mysql-probe-socket-"),
    );
    try {
      const file = path.join(directory, "plain.txt");
      await writeFile(file, "not a socket");
      const messages = new Set<string>();
      for (const socketPath of [
        path.join(directory, "missing.sock"),
        file,
        directory,
      ]) {
        const answer = await probe({
          url: UrlOf(
            await ClosedPort(),
            `?socketPath=${encodeURIComponent(socketPath)}`,
          ),
          timeoutMs: TIMEOUT_MS,
          signal: Unaborted(),
        });
        expect(answer.outcome, socketPath).to.equal("unreachable");
        messages.add("message" in answer ? answer.message : "");
      }
      expect([...messages]).to.have.lengthOf(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
