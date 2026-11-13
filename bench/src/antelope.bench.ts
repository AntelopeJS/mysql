import path from "node:path";
import { defineConfig } from "@antelopejs/interface-core/config";

import { BackendModule, ReadRunSettings } from "./settings";

const BENCH_ROOT = path.resolve(__dirname, "..");
const settings = ReadRunSettings();

/**
 * One `ajs` run: this module and the one backend under test, which implements
 * `@antelopejs/interface-database` for it.
 */
export default defineConfig({
  name: "mysql-nested-bench",
  cacheFolder: ".antelope/cache",
  modules: {
    bench: { source: { type: "local", path: BENCH_ROOT } },
    [settings.backend]: {
      source: {
        type: "local",
        path: settings.module ?? BackendModule(settings.backend),
      },
      config: { url: settings.url },
    },
  },
  test: { folder: "dist" },
});
