import { expect } from "chai";
import path from "node:path";

import { UnitLine } from "../helpers/test-files";

describe("the line scripts/test.sh deals a test file by", () => {
  for (const platform of [path.posix, path.win32]) {
    const file = (...parts: string[]) =>
      platform.join("dist", "test", ...parts);

    it(`names a file of dist/test by itself and writes it with slashes, from ${platform === path.win32 ? "Windows" : "POSIX"} paths`, () => {
      expect(UnitLine(file("cursors.test.js"), platform)).to.equal(
        "cursors.test.js\tdist/test/cursors.test.js",
      );
    });

    it(`puts a file below dist/test in rest and writes it with slashes, from ${platform === path.win32 ? "Windows" : "POSIX"} paths`, () => {
      expect(UnitLine(file("unit", "config.spec.js"), platform)).to.equal(
        "rest\tdist/test/unit/config.spec.js",
      );
    });
  }
});
