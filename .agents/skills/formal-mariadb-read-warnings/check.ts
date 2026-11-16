/**
 * Checks that a MariaDB read never hands its caller a row the engine cut or nulled, and leaves no
 * warning behind on its connection (see SKILL.md). Drives the real `Read`, `Write` and
 * `OpenRowStream` of `src/`, compiled with this folder by `check.mjs`, over the fake driver and
 * MariaDB of `driver.ts` and `engine.ts`. fast-check draws the scenarios, and each one runs once
 * with no writer and then once per position of its writers among the engine's statements. Exits 0
 * when every rule matches the record in SKILL.md, 1 when a rule changed, and 2 when the check could
 * not run.
 */
import { parseArgs } from "node:util";
import fc from "fast-check";

import { Connect, Disconnect, AcquireConnection, GetDialect, Read, Write } from "../../../src/connection";
import { IsNumber, IsString } from "../../../src/implementations/database/guards";
import { OpenRowStream } from "../../../src/implementations/database/row-stream";
import { ident, lit, type Sql, sql } from "../../../src/statement";
import { installDriver } from "./driver";
import { type Cell, type DocRow, MariaDb, ModelError, type Out, type Payload, tagOf } from "./engine";
import { type Mutation, type Op, type Outcome, RULES, type Run, type Scenario, scenarioArb, type Size } from "./rules";

const EXIT = { ok: 0, changed: 1, tool: 2 };
const BOUNDS = {
  ci: { scenarios: 150, size: { rows: 3, ops: 2, writers: 1 } },
  full: { scenarios: 200, size: { rows: 3, ops: 3, writers: 2 } },
};
const DEFAULT_SEED = 2031;
const HANG_MS = 3000;
const TABLELESS = sql`SELECT 1 AS ${ident("one")}`;

/** Rules the code breaks today; SKILL.md records each one. */
const FINDINGS: ReadonlySet<string> = new Set(["NeverWrongPastTheListedWarnings"]);

function statementOf(payload: Payload): Sql {
  const tag = lit(tagOf(payload));
  const merged = sql`JSON_MERGE_PATCH(${ident("doc")}, ${lit("{}")})`;
  switch (payload.kind) {
    case "rows":
      return sql`SELECT ${ident("id")}, ${merged} AS ${ident("j")}, ${tag} AS ${ident("tag")} FROM ${ident("rows")}`;
    case "aggregate":
      return sql`SELECT JSON_ARRAYAGG(${merged}) AS ${ident("j")}, ${tag} AS ${ident("tag")} FROM ${ident("rows")}`;
    case "plain":
      return sql`SELECT ${ident("id")}, ${ident("doc")} AS ${ident("j")}, ${tag} AS ${ident("tag")} FROM ${ident("rows")}`;
    case "update":
      return sql`UPDATE ${ident("rows")} SET ${ident("doc")} = ${merged} WHERE ${tag} <> ${lit("")}`;
    case "stamp":
      return sql`UPDATE ${ident("rows")} SET ${ident("summary")} = (SELECT JSON_ARRAYAGG(${merged}) FROM ${ident("rows")}) WHERE ${tag} <> ${lit("")}`;
  }
}

function withinHang<T>(work: Promise<T>): Promise<T | "hung"> {
  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<"hung">((resolve) => {
    timer = setTimeout(() => resolve("hung"), HANG_MS);
  });
  return Promise.race([work, hung]).finally(() => clearTimeout(timer));
}

function asOut(row: ReadonlyMap<string, unknown>): Out {
  const out: Record<string, Cell> = {};
  for (const [column, value] of row) {
    if (!IsString(value) && !IsNumber(value) && value !== null) {
      throw new ModelError(`column ${column} arrived as a cell the engine never answers`);
    }
    out[column] = value;
  }
  return out;
}

const NOT_AN_ERROR = new Error("the real code threw a value that is not an Error");

async function readOp(op: Extract<Op, { kind: "read" }>): Promise<Pick<Outcome, "delivered" | "error" | "isExhausted">> {
  const statement = statementOf(op.payload);
  try {
    if (op.isHeld) {
      const held = await AcquireConnection();
      try {
        return { delivered: (await Read(statement, held)).map(asOut), error: undefined, isExhausted: true };
      } finally {
        held.release();
      }
    }
    return { delivered: (await Read(statement)).map(asOut), error: undefined, isExhausted: true };
  } catch (thrown) {
    return { delivered: [], error: (thrown instanceof Error ? thrown : NOT_AN_ERROR), isExhausted: true };
  }
}

async function cursorOp(op: Extract<Op, { kind: "cursor" }>): Promise<Pick<Outcome, "delivered" | "error" | "isExhausted">> {
  const delivered: Out[] = [];
  let error: Error | undefined;
  let isExhausted = false;
  const source = await OpenRowStream(statementOf(op.payload), op.batch);
  try {
    for (let call = 0; call < op.calls && !isExhausted; call += 1) {
      const batch = await source.next(op.batch);
      delivered.push(...batch.map(asOut));
      isExhausted = batch.length < op.batch;
    }
  } catch (thrown) {
    error = (thrown instanceof Error ? thrown : NOT_AN_ERROR);
    isExhausted = true;
  } finally {
    await source.close();
  }
  return { delivered, error, isExhausted };
}

async function writeOp(op: Extract<Op, { kind: "write" }>): Promise<{ error: Error | undefined; affected: number | undefined }> {
  const statement = statementOf(op.payload);
  try {
    if (op.isHeld) {
      const held = await AcquireConnection();
      try {
        return { error: undefined, affected: await Write(statement, held) };
      } finally {
        held.release();
      }
    }
    return { error: undefined, affected: await Write(statement) };
  } catch (thrown) {
    return { error: (thrown instanceof Error ? thrown : NOT_AN_ERROR), affected: undefined };
  }
}

/** Takes every connection the pool can give and runs a read that touches no table on each, as the next caller of any of them would. */
async function nextStatement(limit: number): Promise<string | undefined> {
  const held = await Promise.all(Array.from({ length: limit }, () => AcquireConnection()));
  try {
    for (const connection of held) {
      const answered = await Read(TABLELESS, connection).then(
        (rows) => rows.map(asOut),
        (error: unknown) => (error instanceof Error ? error : NOT_AN_ERROR),
      );
      if (answered instanceof Error) {
        return `a table-less read failed on a connection: ${answered.message}`;
      }
      if (answered.length !== 1 || answered[0]?.one !== 1) {
        return `a table-less read answered ${JSON.stringify(answered)}`;
      }
    }
    return undefined;
  } finally {
    for (const connection of held) {
      connection.release();
    }
  }
}

async function runOp(op: Op): Promise<Omit<Outcome, "next">> {
  const idle: Omit<Outcome, "next"> = { delivered: [], error: undefined, isExhausted: true, isHung: false, affected: undefined };
  const work: Promise<Omit<Outcome, "next">> =
    op.kind === "write"
      ? writeOp(op).then((done) => ({ ...idle, ...done }))
      : (op.kind === "read" ? readOp(op) : cursorOp(op)).then((done) => ({ ...idle, ...done }));
  const settled = await withinHang(work);
  return settled === "hung" ? { ...idle, isHung: true } : settled;
}

function apply(table: DocRow[], mutation: Mutation): void {
  if (mutation.kind === "insert") {
    table.push(mutation.row);
  } else if (mutation.kind === "remove") {
    table.splice(mutation.index, 1);
  } else if (mutation.index < table.length) {
    table[mutation.index] = mutation.row;
  }
}

/** Runs a scenario, with its writers committing before the engine statements at `positions`, and answers the run for the rules to judge. */
async function execute(scenario: Scenario, positions: readonly number[]): Promise<Run> {
  const engine = new MariaDb(scenario.rows);
  const uninstall = installDriver(engine);
  try {
    await Connect({ url: "mysql://root@fake/db", dialect: "mariadb", pool: { connectionLimit: scenario.limit } });
    engine.statements = 0;
    const pending = scenario.writers.map((mutation, at) => ({ mutation, position: positions[at] ?? Infinity }));
    engine.beforeStatement = (count) => {
      for (const writer of pending.filter((candidate) => candidate.position === count)) {
        apply(engine.table, writer.mutation);
      }
    };
    const outcomes: Outcome[] = [];
    for (const [index, op] of scenario.ops.entries()) {
      engine.opIndex = index;
      const outcome = await runOp(op);
      const next = outcome.isHung ? undefined : await withinHang(nextStatement(scenario.limit));
      outcomes.push({ ...outcome, next: next === "hung" ? "every connection could not be taken again" : next });
    }
    const dialect = GetDialect();
    return {
      scenario,
      positions,
      outcomes,
      evaluations: engine.evaluations,
      trace: engine.trace,
      isTooDeep: (error) => dialect.capture.tooDeep(error),
    };
  } finally {
    uninstall();
    await Disconnect();
  }
}

interface Counterexample {
  readonly length: number;
  readonly text: string;
}

function describe(run: Run, problems: readonly string[]): string {
  const { scenario } = run;
  const lines = [
    `scenario ${scenario.name}: ${JSON.stringify({ rows: scenario.rows, ops: scenario.ops, writers: scenario.writers, limit: scenario.limit })}`,
    `writers commit before statements ${JSON.stringify(run.positions)}`,
    ...run.trace.map((step, at) => `  ${at}. session ${step.session}: ${step.text} => ${step.answer}`),
    ...run.outcomes.map(
      (outcome, op) =>
        `  op ${op} answered ${JSON.stringify(outcome.delivered)}${outcome.error ? `, failed: ${outcome.error.message}` : ""}${outcome.affected === undefined ? "" : `, wrote ${outcome.affected}`}`,
    ),
    ...problems.map((problem) => `  => ${problem}`),
  ];
  return lines.join("\n");
}

function positionsFor(writers: number, statements: number): number[][] {
  if (writers === 0) {
    return [[]];
  }
  const all: number[][] = [];
  const walk = (prefix: number[]): void => {
    if (prefix.length === writers) {
      all.push(prefix);
      return;
    }
    for (let position = prefix.at(-1) ?? 0; position <= statements; position += 1) {
      walk([...prefix, position]);
    }
  };
  walk([]);
  return all;
}

const PLAIN: DocRow = { containers: 3, bytes: 100, warns: 0 };
const DEEP: DocRow = { containers: 31, bytes: 100, warns: 0 };
const HUGE: DocRow = { containers: 3, bytes: 600, warns: 0 };
const NOISY: DocRow = { containers: 3, bytes: 100, warns: 1 };
const MANY: DocRow = { containers: 3, bytes: 100, warns: 70 };
const BEYOND: DocRow = { containers: 3, bytes: 100, warns: 65_536 };
const MERGED: Payload = { kind: "rows", wrap: 1 };
const SUMMED: Payload = { kind: "aggregate", wrap: 0 };

function pinned(name: string, rows: readonly DocRow[], ops: readonly Op[], writers: readonly Mutation[] = []): Scenario {
  return { name, rows, ops, writers, limit: 2 };
}

/** The reads each fix of the escape chain answers (PRs #41 to #91), run beside the drawn scenarios. */
const PINNED: readonly Scenario[] = [
  pinned("a plain read of a document nested past the limit (#66)", [DEEP], [{ kind: "read", payload: MERGED, isHeld: false }]),
  pinned("a held read of a too-deep document, then a table-less read (#71)", [PLAIN, DEEP], [{ kind: "read", payload: MERGED, isHeld: true }]),
  pinned("an aggregate past max_allowed_packet (#73)", [HUGE, HUGE], [{ kind: "read", payload: SUMMED, isHeld: false }]),
  pinned("a cursor over a too-deep document (#79)", [PLAIN, DEEP], [{ kind: "cursor", payload: MERGED, batch: 1, calls: 3 }]),
  pinned("a cursor over a cut aggregate (#79)", [HUGE, HUGE], [{ kind: "cursor", payload: SUMMED, batch: 1, calls: 2 }]),
  pinned("a cursor over warnings no read fails on, then a too-deep document (#87)", [NOISY, DEEP], [{ kind: "cursor", payload: MERGED, batch: 2, calls: 2 }]),
  pinned(
    "a write that trades a cursor's harmless warning for a too-deep document between its runs (#90)",
    [NOISY, PLAIN],
    [{ kind: "cursor", payload: MERGED, batch: 1, calls: 3 }],
    [{ kind: "set", index: 0, row: DEEP }],
  ),
  pinned("a cursor over more warnings than the server lists by default (#91)", [MANY, PLAIN], [{ kind: "cursor", payload: MERGED, batch: 2, calls: 2 }]),
  pinned("a read of a too-deep document after more warnings than MariaDB lists", [BEYOND, DEEP], [{ kind: "read", payload: MERGED, isHeld: false }]),
  pinned("a cursor over a too-deep document after more warnings than MariaDB lists", [BEYOND, DEEP], [{ kind: "cursor", payload: MERGED, batch: 1, calls: 3 }]),
  pinned("a write that stores an aggregate cut short", [HUGE, HUGE], [{ kind: "write", payload: { kind: "stamp", wrap: 0 }, isHeld: false }]),
  pinned("a write that merges a too-deep document", [DEEP], [{ kind: "write", payload: { kind: "update", wrap: 1 }, isHeld: true }]),
];

interface Settings {
  readonly count: number;
  readonly seed: number;
  readonly size: Size;
  readonly isVerbose: boolean;
  readonly isTrace: boolean;
}

function settings(): Settings {
  const { values } = parseArgs({
    options: {
      full: { type: "boolean", default: false },
      scenarios: { type: "string" },
      seed: { type: "string" },
      verbose: { type: "boolean", default: false },
      trace: { type: "boolean", default: false },
    },
  });
  const bounds = values.full ? BOUNDS.full : BOUNDS.ci;
  return {
    count: values.scenarios === undefined ? bounds.scenarios : Number(values.scenarios),
    seed: values.seed === undefined ? DEFAULT_SEED : Number(values.seed),
    size: bounds.size,
    isVerbose: values.verbose,
    isTrace: values.trace,
  };
}

async function trace(): Promise<number> {
  for (const scenario of PINNED) {
    const run = await execute(scenario, scenario.writers.map(() => 0));
    console.log(describe(run, Object.values(RULES).flatMap((judge) => judge(run))));
  }
  return EXIT.ok;
}

/** Runs every scenario with its writers at each position among the engine's statements, and keeps the shortest counterexample of each rule. */
async function sweep(scenarios: readonly Scenario[]): Promise<{ found: Map<string, Counterexample>; runs: number }> {
  const found = new Map<string, Counterexample>();
  let runs = 0;
  for (const scenario of scenarios) {
    const first = await execute(scenario, []);
    for (const positions of positionsFor(scenario.writers.length, first.trace.length)) {
      const run = positions.length === 0 ? first : await execute(scenario, positions);
      runs += 1;
      for (const [rule, judge] of Object.entries(RULES)) {
        const problems = judge(run);
        if (problems.length > 0 && run.trace.length < (found.get(rule)?.length ?? Infinity)) {
          found.set(rule, { length: run.trace.length, text: describe(run, problems) });
        }
      }
    }
  }
  return { found, runs };
}

async function main(): Promise<number> {
  const options = settings();
  if (options.isTrace) {
    return trace();
  }
  const drawn = fc.sample(scenarioArb(options.size), { numRuns: options.count, seed: options.seed });
  const { found, runs } = await sweep([...PINNED, ...drawn]);
  let changed = false;
  const holding: string[] = [];
  for (const rule of Object.keys(RULES)) {
    const counterexample = found.get(rule);
    const isFinding = FINDINGS.has(rule);
    if (counterexample === undefined && isFinding) {
      console.log(`HOLDS ${rule}`);
    } else if (counterexample === undefined) {
      holding.push(rule);
    } else {
      console.log(`${isFinding ? "finding" : "BROKEN"} ${rule}\n${counterexample.text}`);
    }
    changed ||= (counterexample === undefined) === isFinding;
  }
  if (options.isVerbose) {
    console.log(`holds ${holding.join(", ")} (${options.count} scenarios, seed ${options.seed}, ${runs} runs)`);
  }
  return changed ? EXIT.changed : EXIT.ok;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof ModelError ? `the model does not cover this: ${error.message}` : error);
    process.exit(EXIT.tool);
  },
);

