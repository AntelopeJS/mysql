import { expect } from "chai";

import type { BenchRecord, EngineRecord, RoundRecord } from "./record";
import { IsBenchRecord } from "./record";
import type { CaseTimings, MeasureOutput, SeedOutput } from "./results";
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

const MEASURE: MeasureOutput = {
  mode: "measure",
  backend: "mysql",
  cases: [TIMINGS],
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
  cases: [TIMINGS],
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

describe("bench JSON guards", () => {
  it("accepts each run output and a record as the bench writes them", () => {
    const capture = {
      mode: "capture",
      backend: "postgres",
      cases: [{ id: "x", runs: 2, startedAt: 1, endedAt: 2, error: "boom" }],
    };
    expect([SEED, MEASURE, capture].map(IsRunOutput)).to.deep.equal([
      true,
      true,
      true,
    ]);
    const written: unknown = JSON.parse(
      JSON.stringify({ ...RECORD, baseRevision: "abc1234" }),
    );
    expect([RECORD, written].map(IsBenchRecord)).to.deep.equal([true, true]);
  });

  const runOutputs = {
    "a seed with a null fillMs": { ...SEED, fillMs: null },
    "a seed whose fillMs holds a string": { ...SEED, fillMs: { books: "1" } },
    "a measured case without timings": {
      ...MEASURE,
      cases: [UNTIMED],
    },
    "a measured case whose timings hold a string": {
      ...MEASURE,
      cases: [{ ...TIMINGS, timings: ["1.5"] }],
    },
    "a captured case without its window": {
      mode: "capture",
      backend: "mysql",
      cases: [{ id: "x", runs: 2 }],
    },
    "an unknown backend": { ...MEASURE, backend: "sqlite" },
  };
  for (const [name, value] of Object.entries(runOutputs)) {
    it(`refuses as run output ${name}`, () => {
      expect(IsRunOutput(value)).to.equal(false);
    });
  }

  const records = {
    "an engine seed with a null fillMs": {
      ...RECORD,
      engines: [{ ...ENGINE, seed: { ...SEED, fillMs: null } }],
    },
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
    "a plan statement without its plan": {
      ...RECORD,
      engines: [
        {
          ...ENGINE,
          plans: [{ ...ENGINE.plans[0], statements: [{ text: "SELECT 1" }] }],
        },
      ],
    },
    "a case on an unknown field": {
      ...RECORD,
      cases: [{ ...RECORD.cases[0], field: "author" }],
    },
    "a missing setting": {
      ...RECORD,
      settings: { rows: 1000, rounds: 3, budgetMs: 1000, captureRuns: 2 },
    },
    "a numeric base revision": { ...RECORD, baseRevision: 7 },
  };
  for (const [name, value] of Object.entries(records)) {
    it(`refuses as a record ${name}`, () => {
      expect(IsBenchRecord(value)).to.equal(false);
    });
  }
});
