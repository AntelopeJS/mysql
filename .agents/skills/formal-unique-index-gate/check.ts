import { parseArgs } from "node:util";
import fc from "fast-check";
import type { SchemaDefinition } from "@antelopejs/interface-database/schema";

import { Connect, Disconnect } from "../../../src/connection";
import { GetTablePlan, Schemas, WaitForUniqueIndexes } from "../../../src/implementations/database/schema";
import { VirtualClock, installClock } from "./clock";
import { installDriver } from "./driver";
import { type Conditions, ModelError, MysqlServer } from "./server";
import { type Declaration, type EventKind, type GateAnswer, RULES, type Run, type Scenario, scenarioArb, type Size } from "./rules";

/**
 * Checks that the write gate of a schema never opens before its declared unique indexes exist, and
 * that a registration converges or refuses the writes it covers (see SKILL.md). Drives the real
 * `Schemas.register`, `WaitForUniqueIndexes`, `Connect` and `Disconnect` of `src/`, compiled with
 * this folder by `check.mjs`, over the fake driver and server of `driver.ts` and `server.ts`, on a
 * virtual clock. fast-check draws the scenarios, and each one runs once per placement of its events
 * among the server's statements. Exits 0 when every rule matches the record in SKILL.md, 1 when a
 * rule changed, and 2 when the check could not run.
 */
const EXIT = { ok: 0, changed: 1, tool: 2 };
const BOUNDS = {
  ci: { scenarios: 40, size: { events: 2 }, stride: 4 },
  full: { scenarios: 120, size: { events: 2 }, stride: 2 },
};
const DEFAULT_SEED = 2037;
const HOUR_MS = 3_600_000;
const NO_FAULTS: Conditions = { faults: [], duplicatesUntil: 0, tableHeldUntil: 0, lockHeldUntil: { tables: 0, indexes: 0 } };
const FIELDS = { sku: "string", price: "number" } as const;
const SCHEMAS: Record<Declaration | "bare", SchemaDefinition> = {
  bare: { items: { fields: FIELDS, indexes: {} } },
  unique: { items: { fields: FIELDS, indexes: { price: { unique: true } } } },
  uniqueTwo: { items: { fields: FIELDS, indexes: { price: { unique: true }, sku: { unique: true } } } },
};
const OPTIONS = { url: "mysql://root@fake/db", dialect: "mysql" as const, pool: { connectionLimit: 4 } };
const TABLE = "items";

/** Rules the code breaks today; SKILL.md records each one. */
const FINDINGS: ReadonlySet<string> = new Set(["NeverOpensWithoutItsIndexWhenRegisteredAgain"]);

let numbered = 0;

async function settle(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Lets the code run until it waits for virtual time, moves the clock to its next pause, and repeats until `done`, nothing waits, or an hour has passed. */
async function drive(clock: VirtualClock, done: () => boolean): Promise<void> {
  for (;;) {
    await settle();
    if (done() || !clock.hasPending() || clock.now > HOUR_MS) {
      return;
    }
    clock.advance();
  }
}

function other(declaration: Declaration): Declaration {
  return declaration === "unique" ? "uniqueTwo" : "unique";
}

interface Session {
  readonly id: string;
  readonly gates: GateAnswer[];
  readonly server: MysqlServer;
}

/** The declared unique indexes of the schema's latest registration that the server's catalog does not hold. */
function unheld(session: Session): string[] {
  try {
    const plan = GetTablePlan(session.id, TABLE);
    return plan.indexes.filter((index) => index.unique && !session.server.holds(plan.table, index.name, index.signature)).map((index) => index.name);
  } catch {
    return [];
  }
}

function startWriter(session: Session, writer: string): GateAnswer {
  const answer: GateAnswer = { writer, outcome: "hung", missing: [], unbuilt: [], answeredAfter: undefined, reason: "" };
  session.gates.push(answer);
  WaitForUniqueIndexes(session.id).then(
    (unbuilt) => {
      answer.outcome = "open";
      answer.answeredAfter = session.server.statements;
      answer.unbuilt = unbuilt.map((one) => ({ index: one.index.name, cause: one.cause }));
      answer.missing = unheld(session).filter((name) => !unbuilt.some((one) => one.index.name === name));
    },
    (refusal: unknown) => {
      answer.reason = refusal instanceof Error ? refusal.message : "refused";
      answer.outcome = "refused";
      answer.answeredAfter = session.server.statements;
    },
  );
  return answer;
}

/** Runs a scenario, with its events happening before the server's statements at `positions`, and answers the run for the rules to judge. */
async function execute(scenario: Scenario, positions: readonly number[]): Promise<Run> {
  numbered += 1;
  const clock = new VirtualClock();
  const server = new MysqlServer(clock);
  const undoClock = installClock(clock);
  const undoDriver = installDriver(server);
  const session: Session = { id: `gate${numbered}`, gates: [], server };
  const swallow = () => undefined;
  try {
    await Connect(OPTIONS);
    if (scenario.start === "bare") {
      const bare = Schemas.register(session.id, SCHEMAS.bare);
      let isDone = false;
      void bare.then(() => (isDone = true), swallow);
      await drive(clock, () => isDone);
    }
    server.begin(scenario.conditions);
    const fired = new Set<number>();
    server.beforeStatement = (count) => {
      scenario.events.forEach((event, at) => {
        if (positions[at] === count && !fired.has(at)) {
          fired.add(at);
          happen(event, at);
        }
      });
    };
    let reconnecting: Promise<void> = Promise.resolve();
    const happen = (event: EventKind, at: number) => {
      switch (event) {
        case "reconnect":
          reconnecting = reconnecting
            .then(() => Disconnect())
            .then(() => Connect(OPTIONS))
            .catch(swallow);
          return;
        case "restart":
          server.restart();
          return;
        case "reregister":
          Schemas.register(session.id, SCHEMAS[other(scenario.first)]).catch(swallow);
          return;
        case "writer":
          startWriter(session, `write ${at + 1}`);
      }
    };
    Schemas.register(session.id, SCHEMAS[scenario.first]).catch(swallow);
    await drive(clock, () => false);
    let isReconnected = false;
    void reconnecting.then(() => (isReconnected = true));
    await drive(clock, () => isReconnected);
    server.beforeStatement = undefined;
    const isStillRetrying = clock.hasPending();
    const last = startWriter(session, "the last write");
    await drive(clock, () => last.outcome !== "hung");
    const isStalled = !clock.hasPending() && last.outcome === "hung";
    let isDisconnected = false;
    void Disconnect().then(() => (isDisconnected = true), swallow);
    await drive(clock, () => isDisconnected);
    return {
      scenario,
      positions,
      trace: [...server.trace],
      gates: session.gates,
      isDisconnected,
      isStalled,
      isStillRetrying,
      hasFailedOnOpenPool: server.failedOn.has(server.pools),
      hasObstacle: scenario.conditions.tableHeldUntil * 1000 > clock.now,
      seconds: Math.round(clock.now / 1000),
    };
  } finally {
    undoClock();
    undoDriver();
    Schemas.unregister(session.id);
  }
}

interface Counterexample {
  readonly length: number;
  readonly text: string;
}

function describe(run: Run, problems: readonly string[]): string {
  const { scenario } = run;
  return [
    `scenario ${scenario.name}: ${JSON.stringify({ start: scenario.start, first: scenario.first, conditions: scenario.conditions, events: scenario.events })}`,
    `events happen before statements ${JSON.stringify(run.positions)}`,
    ...run.trace.map((step, at) => `  ${at}. session ${step.session}: ${step.text} => ${step.answer}`),
    ...run.gates.map((gate) => `  ${gate.writer}: ${gate.outcome}${gate.reason ? ` (${gate.reason.slice(0, 120)})` : ""} after statement ${gate.answeredAfter ?? "never"}${gate.unbuilt.length > 0 ? `, unbuilt ${JSON.stringify(gate.unbuilt)}` : ""}`),
    ...problems.map((problem) => `  => ${problem}`),
  ].join("\n");
}

function placements(events: number, statements: number, stride: number): number[][] {
  if (events === 0) {
    return [[]];
  }
  const all: number[][] = [];
  const walk = (prefix: number[]): void => {
    if (prefix.length === events) {
      all.push(prefix);
      return;
    }
    for (let position = 0; position <= statements; position += events === 1 ? 1 : stride) {
      walk([...prefix, position]);
    }
  };
  walk([]);
  return all;
}

const PINNED: readonly Scenario[] = [
  { name: "two reconnects", start: "bare", first: "uniqueTwo", conditions: { ...NO_FAULTS, lockHeldUntil: { tables: 2, indexes: 0 } }, events: ["reconnect", "reconnect"] },
  { name: "a registration, then a write", start: "fresh", first: "unique", conditions: NO_FAULTS, events: ["writer"] },
  { name: "a reconnect while the tables phase runs (#20)", start: "fresh", first: "unique", conditions: NO_FAULTS, events: ["reconnect", "writer"] },
  { name: "a reconnect that stops the index phase (#22)", start: "bare", first: "unique", conditions: NO_FAULTS, events: ["reconnect", "writer"] },
  {
    name: "a KILL of the index build (#23)",
    start: "bare",
    first: "unique",
    conditions: { ...NO_FAULTS, faults: [{ on: "indexDdl", nth: 0, kind: "interrupted" }] },
    events: ["writer"],
  },
  {
    name: "the connection lost after the index was built (#23)",
    start: "bare",
    first: "unique",
    conditions: { ...NO_FAULTS, faults: [{ on: "indexDdl", nth: 0, kind: "lostAfter" }] },
    events: ["writer"],
  },
  { name: "a server restart, then a write (#23)", start: "bare", first: "unique", conditions: NO_FAULTS, events: ["restart", "writer"] },
  { name: "rows that hold a duplicate key (#25)", start: "bare", first: "unique", conditions: { ...NO_FAULTS, duplicatesUntil: undefined }, events: ["writer"] },
  {
    name: "a key too long for the server (#25)",
    start: "bare",
    first: "unique",
    conditions: { ...NO_FAULTS, faults: [{ on: "indexDdl", nth: 0, kind: "tooLong" }] },
    events: ["writer"],
  },
  { name: "a table a long transaction holds (#29)", start: "bare", first: "unique", conditions: { ...NO_FAULTS, tableHeldUntil: 90 }, events: ["writer"] },
  { name: "another process holds the indexes lock", start: "bare", first: "unique", conditions: { ...NO_FAULTS, lockHeldUntil: { tables: 0, indexes: 5 } }, events: ["writer", "reregister"] },
];

interface Settings {
  readonly count: number;
  readonly seed: number;
  readonly size: Size;
  readonly stride: number;
  readonly isVerbose: boolean;
  readonly pinned: number | undefined;
}

function settings(): Settings {
  const { values } = parseArgs({
    options: {
      full: { type: "boolean", default: false },
      scenarios: { type: "string" },
      seed: { type: "string" },
      verbose: { type: "boolean", default: false },
      pinned: { type: "string" },
    },
  });
  const bounds = values.full ? BOUNDS.full : BOUNDS.ci;
  return {
    count: values.scenarios === undefined ? bounds.scenarios : Number(values.scenarios),
    seed: values.seed === undefined ? DEFAULT_SEED : Number(values.seed),
    size: bounds.size,
    stride: bounds.stride,
    isVerbose: values.verbose,
    pinned: values.pinned === undefined ? undefined : Number(values.pinned),
  };
}

async function sweep(scenarios: readonly Scenario[], stride: number): Promise<{ found: Map<string, Counterexample>; runs: number }> {
  const found = new Map<string, Counterexample>();
  let runs = 0;
  for (const scenario of scenarios) {
    const dry = await execute({ ...scenario, events: [] }, []);
    for (const positions of placements(scenario.events.length, dry.trace.length + 2, stride)) {
      const run = await execute(scenario, positions);
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
  if (options.pinned !== undefined) {
    const scenario = PINNED[options.pinned];
    if (scenario) {
      const run = await execute(scenario, scenario.events.map(() => 0));
      console.log(describe(run, Object.values(RULES).flatMap((judge) => judge(run))));
    }
    return EXIT.ok;
  }
  const drawn = fc.sample(scenarioArb(options.size), { numRuns: options.count, seed: options.seed });
  const { found, runs } = await sweep([...PINNED, ...drawn], options.stride);
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
      console.log(isFinding && !options.isVerbose ? `finding ${rule}` : `${isFinding ? "finding" : "BROKEN"} ${rule}\n${counterexample.text}`);
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
