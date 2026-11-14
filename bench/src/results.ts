import {
  ArrayOf,
  IsNumber,
  IsString,
  Member,
  Optional,
  RecordOf,
  Fields,
} from "./guard";
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

const BACKENDS: Readonly<Record<Backend, true>> = {
  mysql: true,
  postgres: true,
};
const IsBackend = Member(BACKENDS);

/** Whether a value read back from JSON is a seeding run's output, fill times and counts included. */
export const IsSeedOutput = Fields<SeedOutput>({
  mode: Member({ seed: true }),
  backend: IsBackend,
  rows: IsNumber,
  fillMs: RecordOf(IsNumber),
  counts: RecordOf(IsNumber),
});

const IsCaptureOutput = Fields<CaptureOutput>({
  mode: Member({ capture: true }),
  backend: IsBackend,
  cases: ArrayOf(
    Fields<CaseCapture>({
      id: IsString,
      runs: IsNumber,
      startedAt: IsNumber,
      endedAt: IsNumber,
      error: Optional(IsString),
    }),
  ),
});

/** Whether a value read back from JSON is one query's warm runs: its timings and answers. */
export const IsCaseTimings = Fields<CaseTimings>({
  id: IsString,
  timings: ArrayOf(IsNumber),
  answer: ArrayOf(IsString),
  expected: ArrayOf(IsString),
  wrongRuns: IsNumber,
  error: Optional(IsString),
});

const IsMeasureOutput = Fields<MeasureOutput>({
  mode: Member({ measure: true }),
  backend: IsBackend,
  cases: ArrayOf(IsCaseTimings),
});

/** Whether a value read back from a run's output file is that run's output: its mode, backend and results. */
export function IsRunOutput(value: unknown): value is RunOutput {
  return (
    IsSeedOutput(value) || IsCaptureOutput(value) || IsMeasureOutput(value)
  );
}
