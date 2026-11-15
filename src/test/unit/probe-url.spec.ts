import { expect } from "chai";

import { probe } from "../../probe";
import { ClosedPort, TIMEOUT_MS, Unaborted } from "./probe-fixture";

/** Long enough that work quadratic in a value takes seconds. */
const LENGTH = 100_000;
const DEPTH = 10_000;

/** A URL value made to cost each kind of work `mysql2` or the URL parser may do with it. */
const HOSTILE: readonly (readonly [string, string])[] = [
  ["flags", `a${" ".repeat(LENGTH)}a`],
  ["timezone", `a${" ".repeat(LENGTH)}a`],
  ["charset", "x".repeat(LENGTH)],
  ["ssl", "x".repeat(LENGTH)],
  ["ssl", `{"ca":"${"x".repeat(LENGTH)}"}`],
  ["connectAttributes", `{"a":${"[".repeat(DEPTH)}${"]".repeat(DEPTH)}}`],
  ["socketPath", "/".repeat(LENGTH)],
  ["debug", "x".repeat(LENGTH)],
  ["x".repeat(LENGTH), "1"],
];

describe("probe, with a URL value made to be slow", function () {
  this.timeout(TIMEOUT_MS * 20);
  let port: number;

  before(async () => {
    port = await ClosedPort();
  });

  for (const [option, value] of HOSTILE) {
    /** Fails on a probe that lets a value reach work in `mysql2` that grows faster than the value. */
    it(`answers within the timeout with ${option.slice(0, 20)} set to ${value.length} characters`, async () => {
      const started = performance.now();
      const answer = await probe({
        url: `mysql://reader:secret@127.0.0.1:${port}/shop?${encodeURIComponent(option)}=${encodeURIComponent(value)}`,
        timeoutMs: TIMEOUT_MS,
        signal: Unaborted(),
      });
      expect(performance.now() - started).to.be.lessThan(TIMEOUT_MS);
      expect(answer.outcome).to.not.equal("signed-in");
    });
  }

  it("answers within the timeout for a host name of 100,000 characters", async () => {
    const started = performance.now();
    const answer = await probe({
      url: `mysql://reader:secret@${"a".repeat(LENGTH)}:${port}/shop`,
      timeoutMs: TIMEOUT_MS,
      signal: Unaborted(),
    });
    expect(performance.now() - started).to.be.lessThan(TIMEOUT_MS * 2);
    expect(answer.outcome).to.not.equal("signed-in");
  });

  /** Fails on a probe that lets `mysql2` look an `ssl` profile up under a name every object inherits. */
  it("refuses an ssl profile named after a property every object inherits, and leaves Object.prototype alone", async () => {
    for (const value of ["__proto__", '"constructor"', "toString"]) {
      const answer = await probe({
        url: `mysql://reader:secret@127.0.0.1:${port}/shop?ssl=${encodeURIComponent(value)}`,
        timeoutMs: TIMEOUT_MS,
        signal: Unaborted(),
      });
      expect(answer, value).to.include({
        outcome: "refused",
        refusal: "other",
      });
      expect(
        Object.hasOwn(Object.prototype, "rejectUnauthorized"),
        value,
      ).to.equal(false);
    }
  });
});
