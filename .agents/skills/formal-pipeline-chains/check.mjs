#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/**
 * Builds the module and compiles this folder into `dist/formal-pipeline-chains`, then runs the two
 * properties of this check through `ajs module test`, one after the other, against the server `MYSQL_TEST_URL` names or else a `MYSQL_TEST_IMAGE`
 * container the run starts. Prints nothing when both hold. Exits 0 when both hold, 1 when one is
 * broken (`BROKEN <property>`, then the counterexample), and 2 when the check could not run.
 */
const TOOL_ERROR = 2;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
const ajs = path.join(root, "node_modules", "@antelopejs", "core", "dist", "core", "cli", "index.js");

const PROPERTIES = [
  { name: "ChainsMatchReference", file: "dist/formal-pipeline-chains/pipeline-chains.test.js", runs: "CHAINS_RUNS", ci: 1000, full: 10_000 },
  { name: "FeedsMatchReference", file: "dist/formal-pipeline-chains/pipeline-chains-feeds.test.js", runs: "FEEDS_RUNS", ci: 30, full: 150 },
];

const { values } = parseArgs({
  options: {
    full: { type: "boolean", default: false },
    "no-build": { type: "boolean", default: false },
    runs: { type: "string" },
    seed: { type: "string" },
  },
});

/**
 * Runs a Node script to its end in this Node, which needs no shell on Windows, and answers its exit
 * code and everything it printed.
 * @param {string} script
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number, output: string }>}
 */
function run(script, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env: { ...process.env, ...env } });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ code: TOOL_ERROR, output: String(error) }));
    child.on("close", (code) => resolve({ code: code ?? TOOL_ERROR, output }));
  });
}

/**
 * What a mocha run says about the tests that failed: the failing property with its counterexample,
 * or the assertion of a test. Empty when no test failed.
 * @param {string} output
 */
function counterexample(output) {
  const failing = output.search(/^\s*\d+ failing/mu);
  if (failing < 0) {
    return "";
  }
  return output
    .slice(failing)
    .split("\n")
    .filter((line) => /^\s*(\d+ failing|\d+\) |Error: |AssertionError|Counterexample|Caused by|\{ seed)/u.test(line))
    .join("\n")
    .slice(0, 3000);
}

if (!values["no-build"]) {
  const built = await run(tsc, []);
  if (built.code !== 0) {
    console.error(`tsc failed on the module\n${built.output}`);
    process.exit(TOOL_ERROR);
  }
}

const compiled = await run(tsc, [
  "-p",
  ".agents/skills/formal-pipeline-chains/tsconfig.json",
  "--outDir",
  "dist/formal-pipeline-chains",
]);
if (compiled.code !== 0) {
  console.error(`tsc failed on .agents/skills/formal-pipeline-chains\n${compiled.output}`);
  process.exit(TOOL_ERROR);
}

let broken = false;
for (const property of PROPERTIES) {
  const env = { [property.runs]: values.runs ?? String(values.full ? property.full : property.ci) };
  if (values.seed) {
    env.CHAINS_SEED = values.seed;
  }
  const { code, output } = await run(ajs, ["module", "test", ".", "-f", property.file], env);
  if (code === 0) {
    continue;
  }
  const found = counterexample(output);
  if (!found) {
    console.error(`${property.name} could not run\n${output.slice(-2000)}`);
    process.exit(TOOL_ERROR);
  }
  console.log(`BROKEN ${property.name}\n${found}`);
  broken = true;
}
process.exit(broken ? 1 : 0);
