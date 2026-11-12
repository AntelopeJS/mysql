/**
 * Checks that a change feed delivers every change committed after it opened, once and in per-row
 * order, or ends with a loss (see SKILL.md). Drives the real `ReadFeedEvent`, `Sequence` and
 * `ReapOnce` of `src/`, compiled with this folder by `check.mjs`, against the fake server of
 * `server.ts`. fast-check draws the scenarios and `explore.ts` runs each under every order of its
 * steps. Exits 0 when every rule matches the record in SKILL.md, 1 when a rule changed, and 2 when
 * the check could not run.
 */
import { availableParallelism } from "node:os";
import { parseArgs } from "node:util";
import { isMainThread, parentPort } from "node:worker_threads";
import fc from "fast-check";
import { QueryStage } from "@antelopejs/interface-database/common";

import { SetOptions } from "../../../src/config";
import { DIALECTS } from "../../../src/dialect";
import { CloseOneFeed, ReadFeedEvent } from "../../../src/implementations/database/feeds";
import { ReapOnce } from "../../../src/implementations/database/reaper";
import { ReadFrontier, Sequence } from "../../../src/implementations/database/sequencer";
import type { RowValue } from "../../../src/implementations/database/result";
import { IsDocument, IsString } from "../../../src/implementations/database/guards";
import { type Drained, exploreOrders, type Schedule } from "./explore";
import { type Change, type Ending, RULES, type Run, type Scenario, scenarioArb, type Size, type WriteSpec } from "./rules";
import {
  FakeServer,
  FEED_INSTANCE,
  FEED_TABLE,
  type FeedProbe,
  OTHER_INSTANCE,
  OTHER_TABLE,
  SCHEMA_ID,
  TABLE_ID,
  type WriteTarget,
} from "./server";
import { type Counterexample, type Exploration, exploreShard, mergeResults, runShards, type ScenarioResult, type Shard } from "./shards";

const EXIT = { ok: 0, changed: 1, tool: 2 };
const BOUNDS = {
  ci: { scenarios: 100, orders: 20_000, size: { seeds: 1, writers: 2, writes: 1, ticks: 1, reapers: 1 } },
  full: { scenarios: 100, orders: 20_000, size: { seeds: 2, writers: 2, writes: 2, ticks: 2, reapers: 2 } },
};
const DEFAULT_SEED = 2023;
const MAX_DEFAULT_JOBS = 4;
/** The most steps one order runs before the check calls it a livelock. */
const STEP_BUDGET = 500;
const LAPSED = /events (\d+) through (\d+) were reaped/;

/** Rules the code breaks today; SKILL.md records each one. */
const FINDINGS: ReadonlySet<string> = new Set<keyof typeof RULES>([]);

interface Options {
  size: Size;
  scenarios: number;
  orders: number;
  seed: number;
  /** How many threads explore the scenarios; 1 explores them in this thread. */
  jobs: number;
  /** The 1-based shard a worker thread explores; only `runShards` passes it. */
  shard: number | undefined;
}

/** Set once the rules are judged, so a crash before that exits as "could not run". */
let judged = false;
let nextReqId = -1_000_000;

const STAGES = [
  QueryStage("schema", { id: SCHEMA_ID }),
  QueryStage("instance", { id: FEED_INSTANCE }),
  QueryStage("table", { id: TABLE_ID }),
  QueryStage("changes"),
];

function target(spec: WriteSpec, label: string): WriteTarget {
  return {
    tbl: spec.place === "otherTable" ? OTHER_TABLE : FEED_TABLE,
    inst: spec.place === "otherInstance" ? OTHER_INSTANCE : FEED_INSTANCE,
    doc: spec.doc,
    op: spec.op,
    label,
  };
}

function changeOf(value: RowValue | undefined): string {
  const change = IsDocument(value) ? value.change : undefined;
  return IsString(change) ? change : `an unknown document ${JSON.stringify(value)}`;
}

function endingOf(message: string, at: number): Ending {
  const lapsed = LAPSED.exec(message);
  if (lapsed) {
    return { kind: "lapsed", from: BigInt(lapsed[1] ?? "0"), to: BigInt(lapsed[2] ?? "0"), at };
  }
  return { kind: "failed", message };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function lockOrder(spec: WriteSpec): string {
  return `${spec.place}:${spec.doc}`;
}

/**
 * The writers of a scenario: each one transaction of its writes, then a commit or a rollback. A
 * writer locks its documents in one order, so writers never deadlock each other: InnoDB would roll
 * one back, which is a writer that rolled back.
 */
function startWriters(server: FakeServer, scenario: Scenario, changes: Change[], start: (name: string, work: () => Promise<void>) => void): void {
  scenario.writers.forEach((writer, index) => {
    const actor = `writer w${index + 1}`;
    const ordered = [...writer.writes].sort((a, b) => lockOrder(a).localeCompare(lockOrder(b)));
    const mine = ordered.map((spec, n) => {
      const change: Change = { label: `w${index + 1}.${n + 1}`, place: spec.place, doc: spec.doc, commitIndex: undefined };
      changes.push(change);
      return { spec, change };
    });
    start(actor, async () => {
      const txn = server.db.begin();
      for (const { spec, change } of mine) {
        await server.write(actor, txn, target(spec, change.label));
      }
      await server.finish(actor, txn, writer.commit, () => {
        for (const { change } of mine) {
          change.commitIndex = server.commits;
        }
      });
    });
  });
}

/** Runs one scenario under the order `schedule` picks, and answers what it left. */
async function runScenario(schedule: Schedule, scenario: Scenario): Promise<Run & { modelErrors: string[]; drained: Drained }> {
  SetOptions({ changeBatchSize: scenario.batch });
  const server = new FakeServer(schedule);
  const changes: Change[] = [];
  const failures: string[] = [];
  const start = (name: string, work: () => Promise<void>) => {
    work().catch((error: unknown) => failures.push(`${name} failed: ${error instanceof Error ? error.message : String(error)}`));
  };
  scenario.seeds.forEach((spec, index) => {
    const label = `s${index + 1}`;
    const placed = target(spec, label);
    server.db.seed(placed.tbl, placed.inst, spec.op, label);
    server.commits += 1;
    changes.push({ label, place: spec.place, doc: spec.doc, commitIndex: server.commits });
  });
  const probe: FeedProbe = { wake: undefined, openedAt: undefined, seen: -1, woken: -1, wakes: 0, done: false };
  const env = server.feedEnvironment(probe);
  const reqId = nextReqId;
  nextReqId -= 1;
  const delivered: string[] = [];
  let ending: Ending = { kind: "closed" };
  let openStartedAt = 0;
  const feed = (async () => {
    const footprint = () => ({ reads: ["commits"], writes: [] });
    await schedule.submit("feed", "start reading", () => true, footprint, () => {
      openStartedAt = server.commits;
      schedule.trace.push(`feed: start reading (after writer commit ${openStartedAt})`);
    });
    try {
      for (;;) {
        const next = await ReadFeedEvent(reqId, STAGES, env);
        if (next.done) {
          break;
        }
        const label = changeOf(next.value.newValue ?? next.value.oldValue);
        delivered.push(label);
        schedule.trace.push(`feed: delivered ${label}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ending = endingOf(message, server.db.now);
      schedule.trace.push(`feed: ended, ${message}`);
    }
    probe.done = true;
  })();
  startWriters(server, scenario, changes, start);
  const dialect = DIALECTS.mysql;
  for (let n = 1; n <= scenario.ticks; n += 1) {
    start(`tick ${n}`, async () => {
      const session = server.session(`tick ${n}`);
      if ((await ReadFrontier(session, dialect)).pending) {
        await Sequence(session, dialect, "skip");
      }
    });
  }
  for (let n = 1; n <= scenario.reapers; n += 1) {
    start(`reaper ${n}`, async () => {
      await ReapOnce(server.session(`reaper ${n}`), dialect, scenario.retention);
    });
  }
  const wake = () => server.wakeStep(probe);
  let drained = await schedule.drain(wake);
  if (drained === "settled") {
    start("final sequencer", () => Sequence(server.session("final sequencer"), dialect, "wait"));
    drained = await schedule.drain(wake);
  }
  await CloseOneFeed(reqId);
  if (drained === "settled") {
    await feed;
  } else {
    await settle();
  }
  const settled =
    drained === "blocked"
      ? `no step can run: ${schedule.waiting().join("; ")}`
      : drained === "overrun"
        ? `the run did not finish within ${STEP_BUDGET} steps`
        : failures[0];
  return {
    changes,
    openStartedAt,
    openedAt: probe.openedAt,
    delivered,
    ending,
    seqs: server.db.numbered,
    passes: server.db.passes,
    retention: scenario.retention,
    reaped: server.db.deleted.get(FEED_TABLE) ?? [],
    settled,
    trace: schedule.trace,
    modelErrors: server.modelErrors,
    drained,
  };
}

function describe(scenario: Scenario, run: Run, problems: string[], picks: number[]): string {
  return [
    `scenario ${JSON.stringify(scenario)}`,
    `picks [${picks.join(",")}]`,
    ...run.trace,
    ...problems.map((problem) => `=> ${problem}`),
  ]
    .map((line) => `  ${line}`)
    .join("\n");
}

/** Explores one drawn scenario under every order that differs, and keeps each rule's shortest counterexample. */
async function exploreScenario(scenario: Scenario, index: number, options: Options): Promise<ScenarioResult> {
  const found = new Map<string, Counterexample>();
  let broken = false;
  const result = await exploreOrders(
    async (schedule) => {
      const run = await runScenario(schedule, scenario);
      if (run.modelErrors.length > 0) {
        throw new Error(`the model could not run this order: ${run.modelErrors[0]}\n${describe(scenario, run, [], [])}`);
      }
      if (run.drained === "covered") {
        return run.drained;
      }
      for (const [rule, judge] of Object.entries(RULES)) {
        const problems = judge(run);
        const length = run.trace.length;
        if (problems.length > 0 && length < (found.get(rule)?.length ?? Infinity)) {
          found.set(rule, { length, text: describe(scenario, run, problems, schedule.picks()) });
        }
        broken ||= problems.length > 0 && !FINDINGS.has(rule);
      }
      return run.drained;
    },
    options.orders,
    STEP_BUDGET,
  );
  return { index, ...result, broken, counterexamples: [...found] };
}

/** Draws the scenarios, and answers the explorer of the one at an index. */
function scenarioExplorer(options: Options): (index: number) => Promise<ScenarioResult> {
  const drawn = fc.sample(scenarioArb(options.size), { numRuns: options.scenarios, seed: options.seed });
  return (index) => {
    const scenario = drawn[index];
    if (!scenario) {
      throw new Error(`scenario ${index} was not drawn`);
    }
    return exploreScenario(scenario, index, options);
  };
}

/** Explores the scenarios, in this thread or split across `options.jobs` worker threads. */
async function explore(options: Options): Promise<Exploration> {
  if (options.jobs === 1) {
    const results: ScenarioResult[] = [];
    await exploreShard(options.scenarios, { index: 0, jobs: 1 }, scenarioExplorer(options), (result) => results.push(result));
    return mergeResults(results, options.scenarios);
  }
  return mergeResults(await runShards(__filename, process.argv.slice(2), options.jobs), options.scenarios);
}

/** Explores this worker thread's shard and posts each result to the main thread. */
async function exploreAsWorker(options: Options, shard: Shard): Promise<void> {
  await exploreShard(options.scenarios, shard, scenarioExplorer(options), (result) => parentPort?.postMessage(result));
}

function positiveInteger(flag: string, given: string | undefined, fallback: number): number {
  if (given === undefined) {
    return fallback;
  }
  const value = Number(given);
  if (!/^\d+$/.test(given) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${flag} takes a positive integer, got ${given}`);
  }
  return value;
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      full: { type: "boolean", default: false },
      scenarios: { type: "string" },
      orders: { type: "string" },
      seed: { type: "string" },
      jobs: { type: "string" },
      shard: { type: "string" },
    },
  });
  const bounds = values.full ? BOUNDS.full : BOUNDS.ci;
  return {
    size: bounds.size,
    scenarios: positiveInteger("--scenarios", values.scenarios, bounds.scenarios),
    orders: positiveInteger("--orders", values.orders, bounds.orders),
    seed: positiveInteger("--seed", values.seed, DEFAULT_SEED),
    jobs: positiveInteger("--jobs", values.jobs, Math.min(availableParallelism(), MAX_DEFAULT_JOBS)),
    shard: values.shard === undefined ? undefined : positiveInteger("--shard", values.shard, 1),
  };
}

async function main(): Promise<number> {
  const options = parseOptions();
  if (options.shard !== undefined) {
    throw new Error("--shard is for the worker threads that --jobs starts");
  }
  const { found, orders, covered, cut, explored } = await explore(options);
  const complete = explored === options.scenarios;
  const holding: string[] = [];
  const unjudged: string[] = [];
  let changed = false;
  for (const rule of Object.keys(RULES)) {
    const counterexample = found.get(rule);
    const isFinding = FINDINGS.has(rule);
    if (counterexample === undefined && !complete) {
      unjudged.push(rule);
    } else if (counterexample === undefined) {
      changed ||= isFinding;
      if (isFinding) {
        console.log(
          cut === 0
            ? `HOLDS ${rule}`
            : `HOLDS ${rule} (unconfirmed: ${cut} scenarios were cut at ${options.orders} orders and may hide it; rerun with a larger --orders)`,
        );
      } else {
        holding.push(rule);
      }
    } else {
      changed ||= !isFinding;
      console.log(`${isFinding ? "finding" : "BROKEN"} ${rule}\n${counterexample.text}`);
    }
  }
  const bounds = `${explored} of ${options.scenarios} scenarios, seed ${options.seed}: ${orders} orders run, ${covered} cut short as covered, ${cut} scenarios cut at ${options.orders} orders`;
  if (holding.length > 0) {
    console.log(`holds ${holding.join(", ")} (${bounds})`);
  }
  if (unjudged.length > 0) {
    console.log(`not judged ${unjudged.join(", ")} (stopped at the first broken rule, ${bounds})`);
  }
  judged = true;
  return changed ? EXIT.changed : EXIT.ok;
}

if (isMainThread) {
  process.on("exit", () => {
    if (!judged) {
      process.exitCode = EXIT.tool;
    }
  });
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(EXIT.tool);
    },
  );
} else {
  const options = parseOptions();
  const shard = { index: (options.shard ?? 1) - 1, jobs: options.jobs };
  exploreAsWorker(options, shard).catch((error: unknown) => {
    console.error(error);
    process.exit(EXIT.tool);
  });
}
