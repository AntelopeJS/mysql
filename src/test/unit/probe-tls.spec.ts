import { expect } from "chai";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { probe } from "../../probe";
import { type FakeServer, TIMEOUT_MS, Unaborted } from "./probe-fixture";
import {
  type ClientLine,
  HandshakeServer,
  SSL_CAPABILITY,
} from "./probe-handshake";

const SECRET = `pem-${randomBytes(6).toString("hex")}`;

/** A device whose content never ends, which a synchronous read would never finish. */
const DEVICE = "/dev/zero";

/** A server that offers TLS and reads whatever the client sends until it closes. */
function TlsServer(lines: ClientLine[]): Promise<FakeServer> {
  return HandshakeServer(
    "mysql_native_password",
    async (line) => {
      lines.push(line);
      while ((await line.next()) !== undefined) {
        continue;
      }
    },
    SSL_CAPABILITY,
  );
}

function Probe(port: number, query: string) {
  return probe({
    url: `mysql://probe:pw@127.0.0.1:${port}/shop?${query}`,
    timeoutMs: TIMEOUT_MS,
    signal: Unaborted(),
  });
}

describe("probe, with TLS options that name local files", function () {
  this.timeout(TIMEOUT_MS * 10);
  let directory: string;
  let file: string;

  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "ajs-mysql-probe-tls-"));
    file = path.join(directory, "trust.pem");
    await writeFile(file, SECRET);
  });

  after(() => rm(directory, { recursive: true, force: true }));

  it("reads no file the URL's ssl ca names", async () => {
    const lines: ClientLine[] = [];
    const server = await TlsServer(lines);
    try {
      const answer = await Probe(
        server.port,
        `ssl=${encodeURIComponent(JSON.stringify({ ca: file }))}`,
      );
      expect(answer.outcome).to.not.equal("signed-in");
      for (const line of lines) {
        expect(line.received().toString("latin1")).to.not.include(SECRET);
      }
    } finally {
      await server.close();
    }
  });

  it("answers within the timeout when the URL's ssl ca or socketPath names a device", async () => {
    const server = await TlsServer([]);
    try {
      for (const query of [
        `ssl=${encodeURIComponent(JSON.stringify({ ca: DEVICE }))}`,
        `socketPath=${encodeURIComponent(DEVICE)}`,
      ]) {
        const started = performance.now();
        const answer = await Probe(server.port, query);
        expect(performance.now() - started, query).to.be.lessThan(
          TIMEOUT_MS * 2,
        );
        expect(answer.outcome, query).to.not.equal("signed-in");
      }
    } finally {
      await server.close();
    }
  });

  it("refuses a URL whose ssl presents a client certificate, before connecting", async () => {
    const server = await TlsServer([]);
    try {
      for (const option of ["cert", "key", "pfx", "passphrase"]) {
        const answer = await Probe(
          server.port,
          `ssl=${encodeURIComponent(JSON.stringify({ [option]: SECRET }))}`,
        );
        expect(answer, option).to.include({
          outcome: "refused",
          refusal: "other",
        });
      }
      expect(server.accepted()).to.equal(0);
    } finally {
      await server.close();
    }
  });
});
