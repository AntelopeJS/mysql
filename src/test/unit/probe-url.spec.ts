import { expect } from "chai";

import { probe } from "../../probe";
import {
  ClosedPort,
  SilentServer,
  TIMEOUT_MS,
  Unaborted,
} from "./probe-fixture";

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

/**
 * Queries that read one way as raw text and another once parsed: the URL parser drops tab, CR and
 * LF, decodes percent-escapes, keeps every repeated key, and `mysql2` keeps the last of them and
 * reads keys by their case.
 */
const DISGUISED: readonly (readonly [string, string])[] = [
  ["a tab inside a refused name", "infile\tStreamFactory=1"],
  ["CR and LF inside a refused name", "infile\r\nStreamFactory=1"],
  ["a percent-escaped refused name", "%69nfileStreamFactory=1"],
  ["a tab inside a client certificate", 'ssl={"ce\trt":"x"}'],
  [
    "a percent-escaped client certificate",
    `ssl=${encodeURIComponent('{"key":"x"}')}`,
  ],
  ["a newline inside an inherited profile", "ssl=__pro\nto__"],
  ["a percent-escaped inherited profile", "ssl=%5F%5Fproto%5F%5F"],
  ["a percent-escaped ssl name", "%73sl=__proto__"],
  ["an inherited profile repeated last", "ssl={}&ssl=__proto__"],
  ["an inherited profile repeated first", "ssl=__proto__&ssl={}"],
  ["a refused option in another case", "SSL=__proto__"],
];

describe("probe, with a URL that reads one way raw and another parsed", function () {
  this.timeout(TIMEOUT_MS * 5);

  for (const [disguise, query] of DISGUISED) {
    /** Fails on a probe that checks the raw query rather than the query `mysql2` reads. */
    it(`refuses ${disguise} before connecting`, async () => {
      const server = await SilentServer();
      try {
        const answer = await probe({
          url: `mysql://reader:secret@127.0.0.1:${server.port}/shop?${query}`,
          timeoutMs: TIMEOUT_MS,
          signal: Unaborted(),
        });
        expect(answer).to.include({ outcome: "refused", refusal: "other" });
        expect(server.accepted()).to.equal(0);
        expect(Object.hasOwn(Object.prototype, "rejectUnauthorized")).to.equal(
          false,
        );
      } finally {
        await server.close();
      }
    });
  }
});
