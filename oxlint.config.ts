import { defineConfig } from "oxlint";
import {
  ANTELOPE_IGNORE_PATTERNS,
  antelopePreset,
} from "@antelopejs/tooling-configs/oxc/lint";

export default defineConfig({
  extends: [antelopePreset()],
  ignorePatterns: ANTELOPE_IGNORE_PATTERNS,
  options: { typeAware: true },
  rules: {
    "eslint/no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["**/dialect/mysql", "**/dialect/mysql/**"],
            message:
              "An engine's dialect is reached through `src/dialect` (DIALECTS, or the connection's dialect), never imported directly.",
          },
        ],
      },
    ],
  },
});
