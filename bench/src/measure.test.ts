import { writeFileSync } from "node:fs";
import { expect } from "chai";
import { setTimeout as sleep } from "node:timers/promises";
import { Schema } from "@antelopejs/interface-database";

import {
  Book,
  INSTANCE_ID,
  Review,
  SCHEMA,
  SCHEMA_ID,
  TABLES,
  type StoredBook,
  type StoredReview,
} from "./dataset";
import { QueryCases, type QueryCase, type QueryTables } from "./queries";
import type {
  CaseCapture,
  CaseTimings,
  RunOutput,
  SeedOutput,
} from "./results";
import { ReadRunSettings, type RunSettings } from "./settings";

const BATCH = 1000;
const WARMUPS = 2;
const MIN_RUNS = 5;
const CAPTURE_GAP_MS = 250;
const THROWN = "the query threw something other than an Error";

const schema = new Schema<{
  [TABLES.bare]: StoredBook;
  [TABLES.indexed]: StoredBook;
  [TABLES.reviews]: StoredReview;
}>(SCHEMA_ID, SCHEMA);

function Tables(indexed: boolean, rows: number): QueryTables {
  const instance = schema.instance(INSTANCE_ID);
  return {
    books: instance.table(indexed ? TABLES.indexed : TABLES.bare),
    reviews: instance.table(TABLES.reviews),
    indexed,
    rows,
  };
}

function Now(): number {
  return performance.timeOrigin + performance.now();
}

async function Fill<T>(
  insert: (rows: T[]) => Promise<string[]>,
  rows: number,
  make: (index: number, rows: number) => T,
): Promise<number> {
  const started = performance.now();
  for (let first = 0; first < rows; first += BATCH) {
    const count = Math.min(BATCH, rows - first);
    await insert(
      Array.from({ length: count }, (_, offset) => make(first + offset, rows)),
    );
  }
  return performance.now() - started;
}

async function Seed(settings: RunSettings): Promise<SeedOutput> {
  const instance = schema.instance(INSTANCE_ID);
  const bare = instance.table(TABLES.bare);
  const indexed = instance.table(TABLES.indexed);
  const reviews = instance.table(TABLES.reviews);
  await Promise.all([
    bare.delete().run(),
    indexed.delete().run(),
    reviews.delete().run(),
  ]);
  const fillMs = {
    [TABLES.bare]: await Fill(
      (rows) => bare.insert(rows).run(),
      settings.rows,
      Book,
    ),
    [TABLES.indexed]: await Fill(
      (rows) => indexed.insert(rows).run(),
      settings.rows,
      Book,
    ),
    [TABLES.reviews]: await Fill(
      (rows) => reviews.insert(rows).run(),
      settings.rows,
      Review,
    ),
  };
  const counts = {
    [TABLES.bare]: await bare.count().run(),
    [TABLES.indexed]: await indexed.count().run(),
    [TABLES.reviews]: await reviews.count().run(),
  };
  return {
    mode: "seed",
    backend: settings.backend,
    rows: settings.rows,
    fillMs,
    counts,
  };
}

function Matches(
  answer: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    answer.length === expected.length &&
    answer.every((id, at) => id === expected[at])
  );
}

async function Answer(
  query: QueryCase,
  rows: number,
): Promise<{ ms: number; answer: string[] }> {
  const started = performance.now();
  const fingerprint = await query.run(Tables(query.indexed, rows));
  const ms = performance.now() - started;
  return { ms, answer: fingerprint() };
}

async function Time(
  query: QueryCase,
  settings: RunSettings,
): Promise<CaseTimings> {
  const expected = query.expected(settings.rows);
  const timings: number[] = [];
  let first: string[] | undefined;
  let wrongRuns = 0;
  try {
    for (let warmup = 0; warmup < WARMUPS; warmup++) {
      const { answer } = await Answer(query, settings.rows);
      first ??= answer;
    }
    const started = performance.now();
    while (
      timings.length < settings.runs &&
      (timings.length < MIN_RUNS ||
        performance.now() - started < settings.budgetMs)
    ) {
      const { ms, answer } = await Answer(query, settings.rows);
      timings.push(ms);
      if (!Matches(answer, expected)) {
        wrongRuns++;
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : THROWN;
    return {
      id: query.id,
      timings,
      answer: first ?? [],
      expected,
      wrongRuns,
      error,
    };
  }
  return { id: query.id, timings, answer: first ?? [], expected, wrongRuns };
}

/** Runs one query `runs` times between two quiet gaps, so the server's log of them stands apart. */
async function Capture(
  query: QueryCase,
  settings: RunSettings,
): Promise<CaseCapture> {
  await sleep(CAPTURE_GAP_MS);
  const startedAt = Now();
  const runs = settings.runs;
  try {
    for (let run = 0; run < runs; run++) {
      await Answer(query, settings.rows);
    }
    return { id: query.id, runs, startedAt, endedAt: Now() };
  } catch (err) {
    const error = err instanceof Error ? err.message : THROWN;
    return { id: query.id, runs, startedAt, endedAt: Now(), error };
  } finally {
    await sleep(CAPTURE_GAP_MS);
  }
}

async function Execute(settings: RunSettings): Promise<RunOutput> {
  await schema.createInstance(INSTANCE_ID).run();
  if (settings.mode === "seed") {
    return Seed(settings);
  }
  const cases = QueryCases();
  if (settings.mode === "capture") {
    const captures: CaseCapture[] = [];
    for (const query of cases) {
      captures.push(await Capture(query, settings));
    }
    return { mode: "capture", backend: settings.backend, cases: captures };
  }
  const timed: CaseTimings[] = [];
  for (const query of cases) {
    timed.push(await Time(query, settings));
  }
  return { mode: "measure", backend: settings.backend, cases: timed };
}

/** What a run left out: a table seeded with another row count, or a query it never ran. */
function Gaps(output: RunOutput, settings: RunSettings): string[] {
  if (output.mode === "seed") {
    return Object.entries(output.counts)
      .filter(([, count]) => count !== settings.rows)
      .map(([table, count]) => `${table} holds ${count} rows`);
  }
  const ran = new Set(output.cases.map((query) => query.id));
  return QueryCases()
    .filter((query) => !ran.has(query.id))
    .map((query) => `${query.id} did not run`);
}

describe("nested-field benchmark", function () {
  this.timeout(0);

  it("runs the mode the orchestrator asked for and writes its output", async () => {
    const settings = ReadRunSettings();
    const output = await Execute(settings);
    writeFileSync(settings.output, JSON.stringify(output));
    expect(Gaps(output, settings)).to.deep.equal([]);
  });
});
