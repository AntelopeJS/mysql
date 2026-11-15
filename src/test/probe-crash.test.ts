import { expect } from "chai";
import { execFile } from "node:child_process";
import path from "node:path";

import { GetOptions } from "../config";
import { TIMEOUT_MS } from "./unit/probe-fixture";

/**
 * Values of kept options that `mysql2` holds raw and uses only once the server has answered, on a
 * socket event, outside any promise of the probe: in the handshake response, and when it starts TLS.
 */
const HOSTILE: readonly (readonly [string, string])[] = [
  ["connectAttributes", '{"a":{"b":1}}'],
  ["connectAttributes", "[1,2]"],
  ["ssl", '{"ca":1}'],
  ["ssl", '{"minVersion":"x"}'],
  ["ssl", '{"servername":{}}'],
  ["ssl", "1"],
  ["ssl", "true"],
  ["compress", "{}"],
  ["keepAliveInitialDelay", "{}"],
  ["localAddress", "{}"],
  ["socketPath", "{}"],
];

/** Runs the probe in a process of its own, which prints its answer, and gives that process's exit code. */
function ProbeInProcess(
  url: string,
): Promise<{ code: number; output: string }> {
  const script = `require(${JSON.stringify(path.join(__dirname, "..", "probe"))})
    .probe({ url: process.argv[1], timeoutMs: ${TIMEOUT_MS}, signal: new AbortController().signal })
    .then((answer) => console.log(JSON.stringify(answer)));`;
  return new Promise((resolve) => {
    execFile(process.execPath, ["-e", script, url], (error, stdout) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, output: stdout });
    });
  });
}

describe("probe, with values mysql2 uses only on a socket event", function () {
  this.timeout(60_000);
  const admin = new URL(GetOptions().url ?? "");

  for (const [option, value] of HOSTILE) {
    /** Fails on a probe whose process ends on a URL value `mysql2` throws on outside the probe's promises. */
    it(`answers, and its process exits normally, with ${option}=${value}`, async () => {
      const url = new URL(admin);
      url.search = `?${option}=${encodeURIComponent(value)}`;
      const { code, output } = await ProbeInProcess(url.toString());
      expect(code, output).to.equal(0);
      expect(output).to.match(/"outcome":"(?:signed-in|refused|unreachable)"/);
    });
  }
});
