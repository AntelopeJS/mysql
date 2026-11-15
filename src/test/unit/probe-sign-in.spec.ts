import { expect } from "chai";

import { probe } from "../../probe";
import { Failed } from "../../probe-line";
import { TIMEOUT_MS, Unaborted } from "./probe-fixture";
import {
  AuthSwitch,
  type ClientLine,
  HandshakeServer,
  OK_PACKET,
} from "./probe-handshake";

function Probe(port: number, query = "") {
  return probe({
    url: `mysql://probe:secret@127.0.0.1:${port}/shop${query}`,
    timeoutMs: TIMEOUT_MS,
    signal: Unaborted(),
  });
}

/** Switches the client to `plugin` once it has answered the greeting. */
function SwitchesTo(plugin: string) {
  return async (line: ClientLine) => {
    await line.next();
    line.send(2, AuthSwitch(plugin, Buffer.alloc(20, 1)));
    await line.next();
  };
}

describe("probe, against a server that greets and asks for what the probe cannot give", function () {
  this.timeout(TIMEOUT_MS * 5);

  for (const plugin of ["client_ed25519", "mysql_old_password"]) {
    /** Fails on a probe that answers a server that answered as if none had. */
    it(`answers a switch to ${plugin}, which mysql2 lacks, as a refusal`, async () => {
      const server = await HandshakeServer(
        "mysql_native_password",
        SwitchesTo(plugin),
      );
      try {
        expect(await Probe(server.port)).to.include({
          outcome: "refused",
          refusal: "other",
        });
      } finally {
        await server.close();
      }
    });
  }

  /** Fails on a probe that answers a server without the TLS the URL asks for as no server. */
  it("answers a server that offers no TLS to a URL that asks for it as a refusal", async () => {
    const server = await HandshakeServer(
      "mysql_native_password",
      async (line) => {
        await line.next();
      },
    );
    try {
      expect(await Probe(server.port, "?ssl={}")).to.include({
        outcome: "refused",
        refusal: "other",
      });
    } finally {
      await server.close();
    }
  });

  /**
   * Fails on a probe whose process ends on what `mysql2` throws outside any promise: here it reads
   * an error packet too short to hold its code while no command waits for an answer.
   */
  it("answers a server that sends a truncated packet with its sign-in, and its caller keeps running", async () => {
    const server = await HandshakeServer(
      "mysql_native_password",
      async (line) => {
        await line.next();
        line.sendAll([
          [2, OK_PACKET],
          [0, Buffer.from([0xff])],
        ]);
        await line.next();
      },
    );
    try {
      expect((await Probe(server.port)).outcome).to.equal("unreachable");
    } finally {
      await server.close();
    }
  });

  /** Fails on a probe that calls a connection lost after the greeting a refusal. */
  it("answers a server that drops the connection after its greeting as unreachable", async () => {
    const server = await HandshakeServer("mysql_native_password", () =>
      Promise.reject(new Error("drop the client")),
    );
    try {
      expect((await Probe(server.port)).outcome).to.equal("unreachable");
    } finally {
      await server.close();
    }
  });
});

function Coded(code: string | undefined, message: string): Error {
  return Object.assign(new Error(message), code === undefined ? {} : { code });
}

describe("probe, telling the server's answer from this host's failure", function () {
  for (const [code, message] of [
    ["HANDSHAKE_NO_SSL_SUPPORT", "Server does not support secure connection"],
    [
      "SELF_SIGNED_CERT_IN_CHAIN",
      "self-signed certificate in certificate chain",
    ],
    ["ERR_SSL_WRONG_VERSION_NUMBER", "wrong version number"],
    [
      undefined,
      "Server requests authentication using unknown plugin client_ed25519.",
    ],
  ] as const) {
    /** Fails on a probe that answers a server that answered as if none had. */
    it(`answers ${code ?? message} after the greeting as a refusal`, () => {
      expect(Failed(Coded(code, message), true, "greeted")).to.include({
        outcome: "refused",
        refusal: "other",
      });
    });
  }

  for (const [code, message] of [
    ["EMFILE", "EMFILE: too many open files"],
    [
      "ERR_WORKER_OUT_OF_MEMORY",
      "Worker terminated due to reaching memory limit",
    ],
    ["ERR_INVALID_PACKAGE_CONFIG", "Cannot read package config"],
  ] as const) {
    /** Fails on a probe that blames the server for a failure of the probing host. */
    it(`answers ${code} after the greeting as no answer, not a refusal`, () => {
      expect(Failed(Coded(code, message), true, "greeted").outcome).to.equal(
        "unreachable",
      );
    });
  }
});
