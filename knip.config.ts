import { antelopeKnipConfig } from "@antelopejs/tooling-configs/knip";

export default antelopeKnipConfig({
  entry: [
    "src/test/**/*.spec.{js,ts}",
    "src/test-external/**/*.test.ts",
    "src/probe-worker.ts",
    ".agents/skills/formal-change-feed-delivery/check.{mjs,ts}",
  ],
  ignoreDependencies: ["@types/mocha"],
});
