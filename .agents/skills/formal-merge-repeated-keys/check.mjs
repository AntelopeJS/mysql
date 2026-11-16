#!/usr/bin/env node
/**
 * Builds the module and runs `dist/test/formal-key-merge.test.js` against a MySQL or MariaDB server, passing `--full`,
 * `--runs <n>` and `--seed <n>` on as `FORMAL_RUNS` and `FORMAL_SEED`. The server is
 * `MYSQL_TEST_URL`, or else a container of `MYSQL_TEST_IMAGE` (default `mysql:8.4`) that the test
 * starts and stops. Prints nothing and exits 0 when the property holds. Exits 1 and prints
 * `BROKEN MergeKeepsLastMember` with the failing seed, the shortest scenario and what each side read when it
 * does not, and exits 2 when the check could not run.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_ERROR = 2;
const FULL_RUNS = "1000";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const env = { ...process.env };

function value(/** @type {string} */ flag) {
  const at = args.indexOf(flag);
  const given = at === -1 ? undefined : args[at + 1];
  if (at !== -1 && !/^[1-9][0-9]*$/.test(given ?? "")) {
    console.error(`${flag} takes a positive integer`);
    process.exit(TOOL_ERROR);
  }
  return given;
}

if (args.includes("--full")) {
  env.FORMAL_RUNS = FULL_RUNS;
}
env.FORMAL_RUNS = value("--runs") ?? env.FORMAL_RUNS;
env.FORMAL_SEED = value("--seed") ?? env.FORMAL_SEED;

const build = spawnSync("pnpm", ["run", "--silent", "build"], { cwd: root, encoding: "utf8" });
if (build.status !== 0) {
  console.error(`${build.stdout}${build.stderr}`);
  process.exit(TOOL_ERROR);
}
const ajs = path.join(root, "node_modules", ".bin", "ajs");
const test = spawnSync(ajs, ["module", "test", ".", "-f", "dist/test/formal-key-merge.test.js"], {
  cwd: root,
  env,
  encoding: "utf8",
});
if (test.status === 0) {
  process.exit(0);
}
const output = `${test.stdout}${test.stderr}`;
if (/AssertionError/.test(output)) {
  console.log(`BROKEN MergeKeepsLastMember`);
  console.log(output);
  process.exit(1);
}
console.error(output);
process.exit(TOOL_ERROR);
