import { expect } from "chai";

import { probe } from "../../probe";
import { TIMEOUT_MS, Unaborted } from "./probe-fixture";
import {
  AuthSwitch,
  type ClientLine,
  HandshakeServer,
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
