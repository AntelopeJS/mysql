import fc from "fast-check";

import type { Conditions, Fault } from "./server";

/**
 * The scenarios the check draws and the rules it judges each run by. A scenario is a server in some
 * state and with some faults, a registration, and events that happen between the server's
 * statements: a reconnect, a restart, another registration, a write that waits at the gate.
 */
export type Declaration = "unique" | "uniqueTwo";
export type EventKind = "reconnect" | "restart" | "reregister" | "writer";

export interface Scenario {
  readonly name: string;
  readonly start: "fresh" | "bare";
  readonly first: Declaration;
  readonly conditions: Conditions;
  readonly events: readonly EventKind[];
}

/** How a write that waited at the gate was answered; the check fills it in as the gate answers. */
export interface GateAnswer {
  writer: string;
  outcome: "open" | "refused" | "hung";
  /** The declared unique indexes that were not built when it opened, and not listed as unbuilt. */
  missing: string[];
  unbuilt: { index: string; cause: string }[];
  /** How many statements the server had run when the write was answered. */
  answeredAfter: number | undefined;
  /** What a refused write was told. */
  reason: string;
}

export interface Run {
  readonly scenario: Scenario;
  readonly positions: readonly number[];
  readonly trace: readonly { readonly session: number; readonly text: string; readonly answer: string }[];
  readonly gates: readonly GateAnswer[];
  /** What a disconnect did once the run ended: whether it ended. */
  readonly isDisconnected: boolean;
  readonly isStalled: boolean;
  /** Whether a pause of the code was still waiting when the run's time ran out. */
  readonly isStillRetrying: boolean;
  /** Whether a condition that keeps a unique index from being built outlasts the run. */
  readonly hasObstacle: boolean;
  /** Whether a statement failed on the pool that was open when the run ended, which a failed registration may answer with. */
  readonly hasFailedOnOpenPool: boolean;
  /** Seconds the run's virtual clock reached. */
  readonly seconds: number;
}

type Judge = (run: Run) => string[];

function final(run: Run): GateAnswer | undefined {
  return run.gates.at(-1);
}

/** The promises, each named for what it keeps. */
function opened(run: Run): string[] {
  return run.gates.flatMap((gate) =>
    gate.outcome === "open" && gate.missing.length > 0
      ? [`${gate.writer} was let through with unique ${gate.missing.join(", ")} neither built nor named as unbuilt, so it could store a duplicate`]
      : [],
  );
}

function isRegisteredAgain(run: Run): boolean {
  return run.scenario.events.includes("reregister");
}

export const RULES = {
  NeverOpensWithoutItsIndex: (run) => (isRegisteredAgain(run) ? [] : opened(run)),
  NeverOpensWithoutItsIndexWhenRegisteredAgain: (run) => (isRegisteredAgain(run) ? opened(run) : []),
  ConvergesOrRefuses: (run) => {
    const gate = final(run);
    if (gate?.outcome !== "hung") {
      return [];
    }
    return [`the last write still waited at the gate when the run ended at ${run.seconds} s of virtual time${run.isStalled ? ", with nothing left that could wake it" : ""}`];
  },
  BuildsWhatALockHeldOff: (run) => {
    const gate = final(run);
    const locked = gate?.unbuilt.filter((one) => one.cause === "locked") ?? [];
    return gate?.outcome === "open" && locked.length > 0 && !run.hasObstacle && !run.isStillRetrying
      ? [`${locked.map((one) => one.index).join(", ")} stayed unbuilt as locked after the lock was gone, and nothing tried again`]
      : [];
  },
  ConvergesOnTheOpenPool: (run) =>
    final(run)?.outcome === "refused" && !run.hasFailedOnOpenPool
      ? ["the last write was refused for a failure of a pool that had ended, though the pool now open had run none"]
      : [],
  Disconnects: (run) => (run.isDisconnected ? [] : ["Disconnect never ended after the run"]),
} satisfies Record<string, Judge>;

function faultsFor(on: Fault["on"]): fc.Arbitrary<Fault["kind"]> {
  switch (on) {
    case "lock":
      return fc.constantFrom("lost", "restart");
    case "tableDdl":
      return fc.constantFrom("lockTimeout", "interrupted", "lost", "lostAfter", "restart");
    case "indexDdl":
      return fc.constantFrom("lockTimeout", "interrupted", "lost", "lostAfter", "present", "restart", "tooLong");
  }
}

const fault: fc.Arbitrary<Fault> = fc.constantFrom("tableDdl" as const, "indexDdl" as const, "lock" as const).chain((on) =>
  fc.record({ on: fc.constant(on), nth: fc.integer({ min: 0, max: 2 }), kind: faultsFor(on) }),
);

const conditions: fc.Arbitrary<Conditions> = fc.record({
  faults: fc.array(fault, { maxLength: 2 }),
  duplicatesUntil: fc.constantFrom(undefined, 0, 0, 3, 30),
  tableHeldUntil: fc.constantFrom(0, 0, 4, 20, 90),
  lockHeldUntil: fc.record({ tables: fc.constantFrom(0, 0, 2, 5), indexes: fc.constantFrom(0, 0, 2, 5) }),
});

export interface Size {
  readonly events: number;
}

export function scenarioArb(size: Size): fc.Arbitrary<Scenario> {
  return fc.record({
    name: fc.constant("drawn"),
    start: fc.constantFrom("fresh" as const, "bare" as const, "bare" as const),
    first: fc.constantFrom("unique" as const, "uniqueTwo" as const),
    conditions,
    events: fc.array(fc.constantFrom("reconnect" as const, "restart" as const, "reregister" as const, "writer" as const), { maxLength: size.events }),
  });
}
