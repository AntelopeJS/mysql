import { expect } from "chai";
import type { ProbeAnswer } from "@antelopejs/interface-database-catalog";

import { GetOptions } from "../config";
import { probe } from "../probe";
import { URL_OPTIONS } from "../probe-options";
import {
  type FakeServer,
  Relay,
  TIMEOUT_MS,
  Unaborted,
} from "./unit/probe-fixture";

/** What a sample value of each option leaves of the answer, beside the answer of a URL without it. */
type Expected = "same answer" | "not signed in" | "refused before connecting";

/**
 * A value for every option the probe sorts, and what it does to the answer. An override is given
 * a value that would break the probe if it reached `mysql2`; a kept option one that shows it was
 * kept where the answer can show it.
 */
const SAMPLES: ReadonlyMap<string, readonly [string, Expected]> = new Map([
  ["socketPath", ["/nonexistent/mysqld.sock", "not signed in"]],
  ["ssl", ["{}", "not signed in"]],
  ["compress", ["true", "same answer"]],
  ["connectAttributes", ['{"x":1}', "same answer"]],
  ["enableKeepAlive", ["true", "same answer"]],
  ["keepAliveInitialDelay", ["1000", "same answer"]],
  ["localAddress", ["127.0.0.1", "same answer"]],
  ["disableEval", ["true", "same answer"]],
  ["stringifyObjects", ["true", "same answer"]],
  ["trace", ["false", "same answer"]],
  ["host", ["nowhere.invalid", "same answer"]],
  ["port", ["1", "same answer"]],
  ["user", ["nobody", "same answer"]],
  ["password", ["wrong", "same answer"]],
  ["database", ["missing", "same answer"]],
  ["pool", ["1", "same answer"]],
  ["connectionLimit", ["1", "same answer"]],
  ["maxIdle", ["1", "same answer"]],
  ["idleTimeout", ["1", "same answer"]],
  ["queueLimit", ["1", "same answer"]],
  ["waitForConnections", ["false", "same answer"]],
  ["gracefulEnd", ["true", "same answer"]],
  ["bigNumberStrings", ["false", "same answer"]],
  ["charset", ["LATIN1_SWEDISH_CI", "same answer"]],
  ["charsetNumber", ["8", "same answer"]],
  ["connectTimeout", ["1", "same answer"]],
  ["dateStrings", ["false", "same answer"]],
  ["decimalNumbers", ["true", "same answer"]],
  ["enableCleartextPlugin", ["true", "same answer"]],
  ["flags", ["-FOUND_ROWS", "same answer"]],
  ["jsonStrings", ["false", "same answer"]],
  ["maxPreparedStatements", ["1", "same answer"]],
  ["multipleStatements", ["true", "same answer"]],
  ["namedPlaceholders", ["true", "same answer"]],
  ["nestTables", ["true", "same answer"]],
  ["resetOnRelease", ["false", "same answer"]],
  ["rowsAsArray", ["true", "same answer"]],
  ["stream", ["1", "same answer"]],
  ["supportBigNumbers", ["false", "same answer"]],
  ["timezone", ["+05:00", "same answer"]],
  ["typeCast", ["false", "same answer"]],
  ["uri", ["mysql://nobody@127.0.0.1:1/x", "same answer"]],
  ["authPlugins", ["{}", "refused before connecting"]],
  ["authSwitchHandler", ["1", "refused before connecting"]],
  ["debug", ["true", "refused before connecting"]],
  ["infileStreamFactory", ["1", "refused before connecting"]],
  ["insecureAuth", ["true", "refused before connecting"]],
  ["isServer", ["true", "refused before connecting"]],
  ["password1", ["secret", "refused before connecting"]],
  ["password2", ["secret", "refused before connecting"]],
  ["password3", ["secret", "refused before connecting"]],
  ["passwordSha1", ["secret", "refused before connecting"]],
  ["Promise", ["1", "refused before connecting"]],
  ["queryFormat", ["1", "refused before connecting"]],
]);

/** Values of kept options outside what the probe passes on, which it refuses before connecting. */
const MALFORMED: readonly (readonly [string, string])[] = [
  ["socketPath", "1"],
  ["socketPath", "{}"],
  ["localAddress", "nowhere.invalid"],
  ["localAddress", "{}"],
  ["ssl", "[1]"],
  ["ssl", "1"],
  ["ssl", '{"ca":1}'],
  ["ssl", '{"rejectUnauthorized":"no"}'],
  ["ssl", '{"servername":"db"}'],
  ["ssl", '{"cert":"x"}'],
  ["ssl", "__proto__"],
];

const EXPECTED_BY_USE = {
  keep: ["same answer", "not signed in"],
  override: ["same answer"],
  refuse: ["refused before connecting"],
} as const;

/** The parts of an answer an option could change; the latency differs from one probe to the next. */
function Decided(answer: ProbeAnswer) {
  return answer.outcome === "signed-in"
    ? {
        outcome: answer.outcome,
        user: answer.user,
        canRead: answer.canRead,
        canWrite: answer.canWrite,
        unreadable: answer.unreadable,
      }
    : answer;
}

describe("probe, with each option a URL's query may set", function () {
  this.timeout(60_000);
  const admin = new URL(GetOptions().url ?? "");
  let relay: FakeServer;
  let baseline: ReturnType<typeof Decided>;

  function Probe(query: string) {
    const url = new URL(admin);
    url.port = String(relay.port);
    url.search = query;
    return probe({
      url: url.toString(),
      timeoutMs: TIMEOUT_MS,
      signal: Unaborted(),
    });
  }

  before(async () => {
    relay = await Relay(admin.hostname, Number(admin.port || 3306));
    baseline = Decided(await Probe(""));
  });

  after(() => relay.close());

  it("has a sample for every option the probe sorts, of the kind its use allows", () => {
    for (const [option, use] of URL_OPTIONS) {
      const sample = SAMPLES.get(option);
      expect(sample, option).to.not.equal(undefined);
      expect(EXPECTED_BY_USE[use], option).to.include(sample?.[1]);
    }
  });

  for (const [option, [value, expected]] of [
    ...SAMPLES,
    ["notAnOption", ["1", "refused before connecting"]] as const,
    ...MALFORMED.map(
      ([option, value]) =>
        [option, [value, "refused before connecting"]] as const,
    ),
  ]) {
    it(`answers ${expected} with ${option}=${value}`, async () => {
      const before = relay.accepted();
      const answer = await Probe(`?${option}=${encodeURIComponent(value)}`);
      if (expected === "refused before connecting") {
        expect(answer).to.include({ outcome: "refused", refusal: "other" });
        expect(relay.accepted()).to.equal(before);
      } else if (expected === "same answer") {
        expect(Decided(answer)).to.deep.equal(baseline);
      } else {
        expect(baseline.outcome).to.equal("signed-in");
        expect(answer.outcome).to.not.equal("signed-in");
      }
    });
  }
});
