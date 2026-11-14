import { expect } from "chai";

import type { BenchRecord, EngineRecord, RoundRecord } from "./record";
import { IsBenchRecord } from "./record";
import type {
  CaptureOutput,
  CaseTimings,
  MeasureOutput,
  RunOutput,
  SeedOutput,
} from "./results";
import { IsRunOutput } from "./results";

const SEED: SeedOutput = {
  mode: "seed",
  backend: "mysql",
  rows: 1000,
  fillMs: { books: 120.5 },
  counts: { books: 1000 },
};

const TIMINGS: CaseTimings = {
  id: "filter-title-path",
  timings: [1.5, 1.4],
  answer: ["a"],
  expected: ["a"],
  wrongRuns: 0,
};

const FAILED: CaseTimings = { ...TIMINGS, error: "boom" };

const MEASURE: MeasureOutput = {
  mode: "measure",
  backend: "mysql",
  cases: [TIMINGS, FAILED],
};

const CAPTURE: CaptureOutput = {
  mode: "capture",
  backend: "postgres",
  cases: [{ id: "x", runs: 2, startedAt: 1, endedAt: 2, error: "boom" }],
};

const ENGINE: EngineRecord = {
  id: "mariadb-11.8",
  image: "mariadb:11.8",
  digest: "sha256:0",
  version: "11.8.3",
  indexedTableDdl: "CREATE TABLE books ()",
  seed: SEED,
  plans: [
    {
      id: "filter-title-path",
      statements: [{ text: "SELECT 1", plan: "ALL", indexes: ["title"] }],
      serverMs: [0.5],
      rowsExamined: [1000],
      logged: 1,
    },
  ],
};

const ROUND: RoundRecord = {
  round: 1,
  engine: "mariadb-11.8",
  loadAverage: "0.10",
  containers: ["mariadb"],
  cases: [TIMINGS, FAILED],
  base: false,
};

const RECORD: BenchRecord = {
  startedAt: "2026-11-14T00:00:00.000Z",
  finishedAt: "2026-11-14T01:00:00.000Z",
  machine: {
    cpu: "x",
    cores: 16,
    memoryGb: 62,
    kernel: "6.1",
    node: "24.0.0",
    docker: "28.0.0",
  },
  settings: { rows: 1000, rounds: 3, runs: 5, budgetMs: 1000, captureRuns: 2 },
  cases: [
    {
      id: "filter-title-path",
      kind: "filter",
      field: "title",
      form: "path",
      indexed: false,
    },
  ],
  engines: [ENGINE],
  rounds: [ROUND],
  baseRevision: undefined,
};

const UNTIMED = { id: "x", answer: [], expected: [], wrongRuns: 0 };

type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/**
 * The JSON of `value` once per value it holds, with that one value written as `null`, named by its
 * key: a guard that skips a field or an element accepts the copy that nulls it.
 */
function EachNulled(
  value: RunOutput | BenchRecord,
): (readonly [string, string])[] {
  const keys: string[] = [];
  JSON.stringify(value, (key: string, field: Json): Json => {
    keys.push(key);
    return field;
  });
  return keys.slice(1).map((key, index) => {
    let seen = 0;
    const json = JSON.stringify(value, (_key: string, field: Json): Json => {
      seen += 1;
      return seen === index + 2 ? null : field;
    });
    return [`"${key}" (value ${index + 1})`, json] as const;
  });
}

describe("bench JSON guards", () => {
  const written = { ...RECORD, baseRevision: "abc1234" };

  it("accepts each run output and a record as the bench writes them", () => {
    expect([SEED, MEASURE, CAPTURE].map(IsRunOutput)).to.deep.equal([
      true,
      true,
      true,
    ]);
    const parsed: unknown = JSON.parse(JSON.stringify(written));
    expect([RECORD, parsed].map(IsBenchRecord)).to.deep.equal([true, true]);
  });

  for (const output of [SEED, MEASURE, CAPTURE]) {
    for (const [name, json] of EachNulled(output)) {
      it(`refuses a ${output.mode} output with a null ${name}`, () => {
        const parsed: unknown = JSON.parse(json);
        expect(IsRunOutput(parsed)).to.equal(false);
      });
    }
  }

  for (const [name, json] of EachNulled(written)) {
    it(`refuses a record with a null ${name}`, () => {
      const parsed: unknown = JSON.parse(json);
      expect(IsBenchRecord(parsed)).to.equal(false);
    });
  }

  const runOutputs = {
    "a measured case without timings": {
      ...MEASURE,
      cases: [UNTIMED],
    },
    "a measured case whose timings hold a string": {
      ...MEASURE,
      cases: [{ ...TIMINGS, timings: ["1.5"] }],
    },
    "a captured case without its window": {
      ...CAPTURE,
      cases: [{ id: "x", runs: 2 }],
    },
    "an unknown backend": { ...MEASURE, backend: "sqlite" },
    "a seed whose fillMs holds a string": { ...SEED, fillMs: { books: "1" } },
  };
  for (const [name, value] of Object.entries(runOutputs)) {
    it(`refuses as run output ${name}`, () => {
      expect(IsRunOutput(value)).to.equal(false);
    });
  }

  const records = {
    "a round case without timings": {
      ...RECORD,
      rounds: [{ ...ROUND, cases: [UNTIMED] }],
    },
    "a non-string machine field": {
      ...RECORD,
      machine: { ...RECORD.machine, kernel: 6 },
    },
    "an unknown engine id": {
      ...RECORD,
      engines: [{ ...ENGINE, id: "sqlite-3" }],
    },
    "a round on an unknown engine": {
      ...RECORD,
      rounds: [{ ...ROUND, engine: "sqlite-3" }],
    },
    "a case of an unknown kind": {
      ...RECORD,
      cases: [{ ...RECORD.cases[0], kind: "scan" }],
    },
    "a case on an unknown field": {
      ...RECORD,
      cases: [{ ...RECORD.cases[0], field: "author" }],
    },
    "a case in an unknown form": {
      ...RECORD,
      cases: [{ ...RECORD.cases[0], form: "raw" }],
    },
    "a missing setting": {
      ...RECORD,
      settings: { rows: 1000, rounds: 3, budgetMs: 1000, captureRuns: 2 },
    },
  };
  for (const [name, value] of Object.entries(records)) {
    it(`refuses as a record ${name}`, () => {
      expect(IsBenchRecord(value)).to.equal(false);
    });
  }
});
