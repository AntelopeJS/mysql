import { antelopeKnipConfig } from "@antelopejs/tooling-configs/knip";

export default antelopeKnipConfig({
  entry: [
    "src/test/**/*.spec.{js,ts}",
    "src/test-external/**/*.test.ts",
    "src/probe-worker.ts",
    ".agents/skills/formal-change-feed-delivery/check.{mjs,ts}",
    ".agents/skills/formal-mariadb-read-warnings/check.{mjs,ts}",
    ".agents/skills/formal-unique-index-gate/check.{mjs,ts}",
    ".agents/skills/formal-pipeline-chains/{check.mjs,*.test.ts}",
  ],
  ignoreDependencies: ["@types/mocha"],
});
