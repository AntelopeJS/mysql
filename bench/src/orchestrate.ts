import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Exec, ImageDigest, RunningContainers } from "./docker";
import type { Engine } from "./engine";
import { MARIADB, MySqlEngine } from "./mysql-engine";
import { PostgresEngine } from "./postgres-engine";
import { QueryCases } from "./queries";
import {
  IsBenchRecord,
  type BenchRecord,
  type BenchSettings,
  type EngineRecord,
  type RoundRecord,
} from "./record";
import { WriteReport } from "./report";
import {
  IsRunOutput,
  type CaptureOutput,
  type MeasureOutput,
  type RunOutput,
  type SeedOutput,
} from "./results";
import { ENV, type RunMode } from "./settings";

const BENCH_ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(BENCH_ROOT, "out");
const AJS = path.resolve(BENCH_ROOT, "..", "node_modules", ".bin", "ajs");
const LOG_TAIL_LINES = 40;

const DEFAULTS: BenchSettings = {
  rows: 100_000,
  rounds: 5,
  runs: 20,
  budgetMs: 8000,
  captureRuns: 5,
};

function Setting(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function ReadSettings(): BenchSettings {
  return {
    rows: Setting("BENCH_ROWS", DEFAULTS.rows),
    rounds: Setting("BENCH_ROUNDS", DEFAULTS.rounds),
    runs: Setting("BENCH_RUNS", DEFAULTS.runs),
    budgetMs: Setting("BENCH_BUDGET_MS", DEFAULTS.budgetMs),
    captureRuns: Setting("BENCH_CAPTURE_RUNS", DEFAULTS.captureRuns),
  };
}

function Progress(message: string): void {
  if (process.env.BENCH_VERBOSE) {
    process.stdout.write(`${new Date().toISOString()} ${message}\n`);
  }
}

function Engines(): Engine[] {
  const prefix = process.env.BENCH_CONTAINER_PREFIX ?? "ajs-mysql-bench";
  return [
    new PostgresEngine(
      "postgres-18",
      "postgres:18-alpine",
      `${prefix}-postgres-18`,
    ),
    new MySqlEngine("mysql-8.4", "mysql:8.4", `${prefix}-mysql-84`),
    new MySqlEngine("mysql-9.7", "mysql:9.7", `${prefix}-mysql-97`),
    new MySqlEngine(
      "mariadb-11.8",
      "mariadb:11.8",
      `${prefix}-mariadb-118`,
      MARIADB,
    ),
    new MySqlEngine(
      "mariadb-12.3",
      "mariadb:12.3",
      `${prefix}-mariadb-123`,
      MARIADB,
    ),
  ];
}

let runCount = 0;

/** One `ajs module test` of the bench module against one engine, answering what it wrote. */
async function RunAjs(
  engine: Engine,
  mode: RunMode,
  settings: BenchSettings,
  runs: number,
): Promise<RunOutput> {
  runCount++;
  const label = `${String(runCount).padStart(3, "0")}-${engine.id}-${mode}`;
  const output = path.join(OUTPUT, `${label}.json`);
  const log = path.join(OUTPUT, `${label}.log`);
  const env = {
    ...process.env,
    [ENV.backend]: engine.backend,
    [ENV.url]: engine.url(),
    [ENV.mode]: mode,
    [ENV.output]: output,
    [ENV.rows]: String(settings.rows),
    [ENV.runs]: String(runs),
    [ENV.budgetMs]: String(settings.budgetMs),
  };
  const failure = await new Promise<Error | undefined>((resolve) => {
    execFile(
      AJS,
      ["module", "test", "."],
      { cwd: BENCH_ROOT, env, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        writeFileSync(log, `${stdout}\n${stderr}`);
        resolve(err ?? undefined);
      },
    );
  });
  if (failure) {
    const tail = readFileSync(log, "utf8")
      .split("\n")
      .slice(-LOG_TAIL_LINES)
      .join("\n");
    throw new Error(
      `${label} failed (${failure.message}); log ${log}:\n${tail}`,
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(output, "utf8"));
  if (!IsRunOutput(parsed)) {
    throw new Error(`${label} wrote no run output to ${output}`);
  }
  return parsed;
}

function IsSeed(output: RunOutput): output is SeedOutput {
  return output.mode === "seed";
}

function IsCapture(output: RunOutput): output is CaptureOutput {
  return output.mode === "capture";
}

function IsMeasure(output: RunOutput): output is MeasureOutput {
  return output.mode === "measure";
}

async function Seeded(
  engine: Engine,
  settings: BenchSettings,
): Promise<SeedOutput> {
  const output = await RunAjs(engine, "seed", settings, 1);
  if (
    !IsSeed(output) ||
    Object.values(output.counts).some((count) => count !== settings.rows)
  ) {
    throw new Error(
      `${engine.id} seeded another row count than ${settings.rows}`,
    );
  }
  return output;
}

async function Captured(engine: Engine, settings: BenchSettings) {
  return engine.capture(async () => {
    const output = await RunAjs(
      engine,
      "capture",
      settings,
      settings.captureRuns,
    );
    if (!IsCapture(output)) {
      throw new Error(`${engine.id} answered no capture`);
    }
    return output;
  });
}

async function Measured(
  engine: Engine,
  settings: BenchSettings,
  round: number,
): Promise<RoundRecord> {
  const loadAverage = readFileSync("/proc/loadavg", "utf8").trim();
  const containers = RunningContainers();
  const output = await RunAjs(engine, "measure", settings, settings.runs);
  if (!IsMeasure(output)) {
    throw new Error(`${engine.id} answered no measurement`);
  }
  return {
    round,
    engine: engine.id,
    loadAverage,
    containers,
    cases: output.cases,
  };
}

/** Each round starts on the next engine, so warm-up and drift favour none of them. */
function RoundOrder(engines: readonly Engine[], round: number): Engine[] {
  return engines.map((_, at) => engines[(at + round) % engines.length]);
}

function Machine() {
  const cpu = os.cpus()[0]?.model ?? "unknown";
  return {
    cpu,
    cores: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    kernel: `${os.type()} ${os.release()}`,
    node: process.version,
    docker: Exec("docker", [
      "version",
      "--format",
      "{{.Server.Version}}",
    ]).trim(),
  };
}

async function Main(): Promise<void> {
  const settings = ReadSettings();
  const startedAt = new Date().toISOString();
  mkdirSync(OUTPUT, { recursive: true });
  const engines = Engines();
  try {
    Progress("starting servers");
    await Promise.all(engines.map((engine) => engine.start()));
    Progress("seeding");
    const seeds = await Promise.all(
      engines.map((engine) => Seeded(engine, settings)),
    );
    const records: EngineRecord[] = [];
    for (const [at, engine] of engines.entries()) {
      await engine.analyze();
      Progress(`capturing ${engine.id}`);
      records.push({
        id: engine.id,
        image: engine.image,
        digest: ImageDigest(engine.image),
        version: await engine.version(),
        indexedTableDdl: await engine.indexedTableDdl(),
        seed: seeds[at],
        plans: await Captured(engine, settings),
      });
    }
    const rounds: RoundRecord[] = [];
    for (let round = 0; round < settings.rounds; round++) {
      for (const engine of RoundOrder(engines, round)) {
        Progress(`round ${round + 1}: ${engine.id}`);
        rounds.push(await Measured(engine, settings, round));
      }
    }
    const record: BenchRecord = {
      startedAt,
      finishedAt: new Date().toISOString(),
      machine: Machine(),
      settings,
      cases: QueryCases().map(({ id, kind, field, form, indexed }) => ({
        id,
        kind,
        field,
        form,
        indexed,
      })),
      engines: records,
      rounds,
    };
    writeFileSync(path.join(OUTPUT, "record.json"), JSON.stringify(record));
    WriteReport(record, BENCH_ROOT);
  } finally {
    if (!process.env.BENCH_KEEP_SERVERS) {
      await Promise.all(engines.map((engine) => engine.stop()));
    }
  }
}

/** Writes the report again from the last run's record, measuring nothing. */
function ReportOnly(): void {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(OUTPUT, "record.json"), "utf8"),
  );
  if (!IsBenchRecord(parsed)) {
    throw new Error("out/record.json holds no benchmark record");
  }
  WriteReport(parsed, BENCH_ROOT);
}

const run = process.argv.includes("--report") ? async () => ReportOnly() : Main;

run().catch((err: unknown) => {
  process.stderr.write(
    `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exitCode = 1;
});
