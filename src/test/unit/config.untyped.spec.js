import { expect } from "chai";

import { SetOptions } from "../../config";

const VALIDATED = [
  "cursorBatchSize",
  "cursorIdleTimeoutMs",
  "maxOpenCursors",
  "changeRetentionMs",
  "changeBatchSize",
  "changePollIntervalMs",
];

const REFUSED_NON_NUMBERS = ["100", null, {}];

describe("SetOptions from an untyped configuration", () => {
  for (const option of VALIDATED) {
    it(`refuses a ${option} that is not a number, naming it`, () => {
      for (const value of REFUSED_NON_NUMBERS) {
        expect(() => SetOptions({ [option]: value })).to.throw(option);
      }
    });
  }

  it("refuses a statementTimeoutMs that is not a number", () => {
    expect(() => SetOptions({ statementTimeoutMs: "5" })).to.throw(
      /statementTimeoutMs/,
    );
  });

  it("refuses a dialect it has no entry for, naming it", () => {
    expect(() => SetOptions({ dialect: "oracle" })).to.throw("oracle");
    expect(() => SetOptions({ dialect: "toString" })).to.throw("toString");
  });

  it("refuses a pool option the module sets itself, naming each", () => {
    expect(() => SetOptions({ pool: { jsonStrings: false } })).to.throw(
      "pool.jsonStrings",
    );
    expect(() => SetOptions({ pool: { uri: "mysql://x/y" } })).to.throw(
      "pool.uri",
    );
    expect(() => SetOptions({ pool: { resetOnRelease: true } })).to.throw(
      "pool.resetOnRelease",
    );
  });

  it("refuses a mode it does not know", () => {
    expect(() => SetOptions({ mode: "readonly" })).to.throw("readonly");
  });
});
