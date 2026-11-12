import path from "node:path";

/** The module that implements the database interface in one run. */
export type Backend = "mysql" | "postgres";

/** What one `ajs` run of the measuring test does. */
export type RunMode = "seed" | "capture" | "measure";

/** What the orchestrator hands one `ajs` run, through its environment. */
export interface RunSettings {
  readonly backend: Backend;
  readonly url: string;
  readonly mode: RunMode;
  readonly output: string;
  readonly rows: number;
  readonly runs: number;
  readonly budgetMs: number;
}

const BACKENDS: readonly Backend[] = ["mysql", "postgres"];
const MODES: readonly RunMode[] = ["seed", "capture", "measure"];
const REPOSITORY = path.resolve(__dirname, "..", "..");

/** The environment variables a run reads, by setting. */
export const ENV = {
  backend: "BENCH_BACKEND",
  url: "BENCH_URL",
  mode: "BENCH_MODE",
  output: "BENCH_OUTPUT",
  rows: "BENCH_ROWS",
  runs: "BENCH_RUNS",
  budgetMs: "BENCH_BUDGET_MS",
} as const;

function Required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

function OneOf<T extends string>(name: string, allowed: readonly T[]): T {
  const value = Required(name);
  const found = allowed.find((candidate) => candidate === value);
  if (!found) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  }
  return found;
}

function PositiveInteger(name: string): number {
  const value = Number(Required(name));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** Reads the settings of this run from the environment the orchestrator set. */
export function ReadRunSettings(): RunSettings {
  return {
    backend: OneOf(ENV.backend, BACKENDS),
    url: Required(ENV.url),
    mode: OneOf(ENV.mode, MODES),
    output: Required(ENV.output),
    rows: PositiveInteger(ENV.rows),
    runs: PositiveInteger(ENV.runs),
    budgetMs: PositiveInteger(ENV.budgetMs),
  };
}

/** The folder `ajs` loads a backend from: this repository, or the published postgres package. */
export function BackendModule(backend: Backend): string {
  return backend === "mysql"
    ? REPOSITORY
    : path.dirname(
        require.resolve("@antelopejs/postgres/package.json", {
          paths: [REPOSITORY],
        }),
      );
}
