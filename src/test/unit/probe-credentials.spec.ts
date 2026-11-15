import { expect } from "chai";
import {
  constants,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
} from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { probe } from "../../probe";
import {
  ClosedPort,
  ErrorPayload,
  TIMEOUT_MS,
  Unaborted,
} from "./probe-fixture";
import {
  AuthSwitch,
  type ClientLine,
  HandshakeServer,
  type HandshakeResponse,
  MoreData,
  OK_PACKET,
  ParseResponse,
} from "./probe-handshake";

const SECRET = `secret-${randomBytes(6).toString("hex")}`;
const ACCESS_DENIED = 1045;
const PERFORM_FULL_AUTHENTICATION = 0x04;

/** The variables a MySQL client reads its password, user and server from. */
const CLIENT_VARIABLES = [
  "MYSQL_PWD",
  "MYSQL_HOST",
  "MYSQL_TCP_PORT",
  "MYSQL_USER",
  "HOME",
  "USERPROFILE",
];

function Probe(url: string) {
  return probe({ url, timeoutMs: TIMEOUT_MS, signal: Unaborted() });
}

/** Runs `work` with the process's environment set to `values`, then puts it back as it was. */
async function WithEnvironment<T>(
  values: Readonly<Record<string, string>>,
  work: () => Promise<T>,
): Promise<T> {
  const saved = new Map(
    CLIENT_VARIABLES.map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, values);
  try {
    return await work();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/** The authentication data rotated by the scramble, as `caching_sha2_password` encrypts it. */
function Unrotated(data: Buffer, scramble: Buffer): string {
  return Buffer.from(
    data.map((byte, index) => byte ^ scramble[index % scramble.length]),
  ).toString("utf8");
}

describe("probe, against a server that asks for credentials", function () {
  this.timeout(TIMEOUT_MS * 5);

  /** Fails on a probe whose client takes a password, user or server from the probing process. */
  it("signs in with what the URL carries, never with MYSQL_PWD, MYSQL_HOST or ~/.my.cnf", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "ajs-mysql-probe-home-"));
    let response: HandshakeResponse | undefined;
    const server = await HandshakeServer(
      "mysql_native_password",
      async (line) => {
        const packet = await line.next();
        response = packet && ParseResponse(packet.payload);
        line.send(2, ErrorPayload(ACCESS_DENIED, "Access denied", "28000"));
      },
    );
    try {
      await writeFile(
        path.join(home, ".my.cnf"),
        `[client]\nuser=leaked\npassword=${SECRET}\nhost=127.0.0.2\n`,
      );
      const answer = await WithEnvironment(
        {
          MYSQL_PWD: SECRET,
          MYSQL_HOST: "127.0.0.2",
          MYSQL_TCP_PORT: String(await ClosedPort()),
          MYSQL_USER: "leaked",
          HOME: home,
          USERPROFILE: home,
        },
        () => Probe(`mysql://probe@127.0.0.1:${server.port}/shop`),
      );
      expect(server.accepted()).to.equal(1);
      expect(response?.user).to.equal("probe");
      expect(response?.token).to.have.lengthOf(0);
      expect(answer).to.include({
        outcome: "refused",
        refusal: "sign-in-required",
      });
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  /** Fails on a probe that lets a URL, or the server, turn on `mysql_clear_password` without TLS. */
  it("never sends the password in clear when the server switches to mysql_clear_password", async () => {
    let client: ClientLine | undefined;
    const server = await HandshakeServer(
      "mysql_native_password",
      async (line) => {
        client = line;
        await line.next();
        line.send(2, AuthSwitch("mysql_clear_password", Buffer.alloc(0)));
        await line.next();
      },
    );
    try {
      const answer = await Probe(
        `mysql://probe:${SECRET}@127.0.0.1:${server.port}/shop?enableCleartextPlugin=true`,
      );
      expect(client?.received().toString("latin1")).to.not.include(SECRET);
      expect(answer).to.include({ outcome: "refused", refusal: "other" });
    } finally {
      await server.close();
    }
  });

  /** Fails on a probe whose client sends anything but the URL's password, sealed with the server's key. */
  it("sends caching_sha2_password only the URL's password, encrypted with the key the server sends", async () => {
    const keys = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    let client: ClientLine | undefined;
    let password: string | undefined;
    const server = await HandshakeServer(
      "caching_sha2_password",
      async (line) => {
        client = line;
        await line.next();
        line.send(2, MoreData(Buffer.from([PERFORM_FULL_AUTHENTICATION])));
        await line.next();
        line.send(4, MoreData(Buffer.from(keys.publicKey)));
        const sealed = await line.next();
        password =
          sealed &&
          Unrotated(
            privateDecrypt(
              {
                key: keys.privateKey,
                oaepHash: "sha1",
                padding: constants.RSA_PKCS1_OAEP_PADDING,
              },
              sealed.payload,
            ),
            line.scramble,
          );
        line.send(6, OK_PACKET);
      },
    );
    try {
      await Probe(`mysql://probe:${SECRET}@127.0.0.1:${server.port}/shop`);
      expect(password).to.equal(`${SECRET}\0`);
      expect(client?.received().toString("latin1")).to.not.include(SECRET);
    } finally {
      await server.close();
    }
  });
});
