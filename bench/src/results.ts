import type { Backend } from "./settings";

/** What a seeding run wrote: the time each table took to fill, and the rows it then counted. */
export interface SeedOutput {
  readonly mode: "seed";
  readonly backend: Backend;
  readonly rows: number;
  readonly fillMs: Record<string, number>;
  readonly counts: Record<string, number>;
}

/** When one query's runs ran in a capture run, so the statements the server logged can be told apart. */
export interface CaseCapture {
  readonly id: string;
  readonly runs: number;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly error?: string;
}

/** The warm runs of one query: each run's time in ms, and how many answered something else than expected. */
export interface CaseTimings {
  readonly id: string;
  readonly timings: readonly number[];
  readonly answer: readonly string[];
  readonly expected: readonly string[];
  readonly wrongRuns: number;
  readonly error?: string;
}

export interface CaptureOutput {
  readonly mode: "capture";
  readonly backend: Backend;
  readonly cases: readonly CaseCapture[];
}

export interface MeasureOutput {
  readonly mode: "measure";
  readonly backend: Backend;
  readonly cases: readonly CaseTimings[];
}

export type RunOutput = SeedOutput | CaptureOutput | MeasureOutput;

const MODES: ReadonlySet<string> = new Set(["seed", "capture", "measure"]);
const BACKENDS: ReadonlySet<string> = new Set(["mysql", "postgres"]);

interface RunHeader {
  readonly mode: string;
  readonly backend: string;
}

function HasHeader(value: unknown): value is RunHeader {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "mode") &&
    Object.hasOwn(value, "backend") &&
    "mode" in value &&
    "backend" in value &&
    typeof value.mode === "string" &&
    typeof value.backend === "string" &&
    MODES.has(value.mode) &&
    BACKENDS.has(value.backend)
  );
}

interface SeedCounts extends RunHeader {
  readonly rows: number;
  readonly fillMs: object;
  readonly counts: object;
}

function HasSeedCounts(value: RunHeader): value is SeedCounts {
  return (
    Object.hasOwn(value, "rows") &&
    Object.hasOwn(value, "fillMs") &&
    Object.hasOwn(value, "counts") &&
    "rows" in value &&
    "fillMs" in value &&
    "counts" in value &&
    typeof value.rows === "number" &&
    typeof value.fillMs === "object" &&
    typeof value.counts === "object"
  );
}

/** Whether a value read back from a run's output file is that run's output: its mode, backend and results. */
export function IsRunOutput(value: unknown): value is RunOutput {
  if (!HasHeader(value)) {
    return false;
  }
  if (value.mode === "seed") {
    return HasSeedCounts(value);
  }
  return (
    Object.hasOwn(value, "cases") &&
    "cases" in value &&
    Array.isArray(value.cases)
  );
}
