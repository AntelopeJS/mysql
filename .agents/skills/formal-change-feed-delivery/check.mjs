#!/usr/bin/env node
/**
 * Compiles this folder with the `src/` it imports into a scratch folder and
 * runs `check.ts` there, passing the arguments through. Exits as the check
 * does: 0 when every rule matches the record in SKILL.md, 1 when a rule
 * changed, 2 when the check could not run. SIGINT, SIGTERM and SIGHUP stop
 * the compile or the check and remove the scratch folder.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_ERROR = 2;
const skill = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(skill, "../../..");
/**
 * Code the check copies rather than runs, since the real code takes a pooled connection: the feed's
 * open, copied in `server.ts`, and the change clock's look, copied as the tick in `check.ts`.
 */
const COPIED = [
  {
    file: "src/implementations/database/feeds.ts",
    copy: "the feed's open in server.ts",
    text: `
      await Sequence(session, dialect, "wait");
      return ReadFrontier(session, dialect);
    }),
  read: ReadWarned,`,
  },
  {
    file: "src/implementations/database/change-loop.ts",
    copy: "the tick in check.ts",
    text: `
  let frontier = await ReadFrontier(session, dialect);
  if (frontier.pending) {
    await Sequence(session, dialect, "skip");`,
  },
];
for (const { file, copy, text } of COPIED) {
  if (!readFileSync(path.join(root, file), "utf8").includes(text)) {
    console.error(`${file} no longer matches ${copy}: update the copy, then its text in check.mjs`);
    process.exit(TOOL_ERROR);
  }
}
const out = mkdtempSync(path.join(tmpdir(), "formal-change-feed-delivery-"));
/** @type {import("node:child_process").ChildProcess | undefined} */
let running;

function finish(/** @type {number} */ code) {
  rmSync(out, { recursive: true, force: true });
  process.exit(code);
}

function stopOn(/** @type {NodeJS.Signals} */ signal, /** @type {number} */ code) {
  process.on(signal, () => {
    running?.kill(signal);
    finish(code);
  });
}

function run(/** @type {string} */ command, /** @type {string[]} */ args) {
  return new Promise(/** @param {(code: number) => void} resolve */ (resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    running = child;
    child.on("error", () => resolve(TOOL_ERROR));
    child.on("exit", (code) => resolve(code ?? TOOL_ERROR));
  });
}

stopOn("SIGINT", 130);
stopOn("SIGTERM", 143);
stopOn("SIGHUP", 129);
symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "dir");
const tsc = path.join(root, "node_modules", ".bin", "tsc");
const compiled = await run(tsc, ["-p", path.join(skill, "tsconfig.json"), "--outDir", out]);
if (compiled !== 0) {
  console.error("tsc failed");
  finish(TOOL_ERROR);
}
const entry = path.join(out, path.relative(root, skill), "check.js");
finish(await run(process.execPath, [entry, ...process.argv.slice(2)]));
