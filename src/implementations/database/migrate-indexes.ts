import { setTimeout as delay } from "node:timers/promises";

import { Logger } from "../../logger";
import type { DdlFailure } from "../../dialect";
import { GetDialect, RegisterBeforeDisconnect } from "../../connection";
import { Observe } from "./observe";
import { SchemaKey } from "./registry";
import type { TablePlan } from "./plan";
import {
  HoldsUniqueIndexes,
  type IndexStep,
  NextIndexStep,
} from "./convergence";
import {
  type ConvergenceSession,
  FailureOf,
  Interrupt,
  LOCK_ATTEMPTS,
  PauseUnlessStopped,
  RetryDelayMs,
  WithIndexesLock,
} from "./locks";

/** A running index phase: the session it builds on while it holds the lock, and what stops it. */
interface IndexBuild {
  session?: ConvergenceSession;
  readonly stop: AbortController;
}

const INDEX_BUILD_STOPPED = new Error(
  "MySQL index build stopped: the adapter is disconnecting",
);

/** The pause before an index phase the server stopped starts again, doubled at each attempt. */
const RESTART_FIRST_MS = 1000;

/** The longest pause between two attempts at an index phase the server keeps stopping. */
const RESTART_MAX_MS = 30_000;

/**
 * How the server stops a build without refusing it: a killed statement, as a shutdown or `KILL QUERY`
 * stops it, or an ended connection, as a restart, a network drop or `KILL` ends it.
 */
const STOPPED_BY_SERVER: ReadonlySet<DdlFailure> = new Set([
  "interrupted",
  "disconnected",
]);

const builds = new Set<IndexBuild>();
const phases = new Set<Promise<void>>();

function Describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function WarnSkipped(plan: TablePlan, step: IndexStep, cause: unknown): void {
  Logger.Warn(
    `Index phase of '${plan.schemaId}.${plan.tableId}' could not ${step.kind} '${step.target}': ${Describe(cause)}. Queries stay correct without it; the next registration tries again`,
  );
}

/** What one failed index step means for the rest of the phase; `stop` ends it. */
type Recovery = "retry" | "done" | "skip" | "stop";

function Recover(failure: DdlFailure, attempts: number): Recovery {
  if (failure === "lockTimeout" && attempts < LOCK_ATTEMPTS) {
    return "retry";
  }
  if (failure === "present" || failure === "absent") {
    return "done";
  }
  if (failure === "lockTimeout" || failure === "refused") {
    return "skip";
  }
  return "stop";
}

/**
 * Brings one table's indexes and key columns in line with its plan, one statement at a time,
 * reading the catalog again before each. A statement the server refuses, such as a unique index over
 * duplicates, is logged and left for the next registration while the others proceed; a killed
 * statement or a broken session ends this attempt at the phase.
 */
export async function ConvergeIndexes(
  session: ConvergenceSession,
  plan: TablePlan,
  isStopping: () => boolean,
): Promise<number> {
  const skipped = new Set<string>();
  let steps = 0;
  let attempts = 0;
  let previous: string | undefined;
  for (;;) {
    if (isStopping()) {
      throw INDEX_BUILD_STOPPED;
    }
    const observed = await Observe(session, plan.table);
    const step =
      observed && NextIndexStep(GetDialect(), plan, observed, skipped);
    if (!step) {
      return steps;
    }
    const key = `${step.kind} '${step.target}'`;
    if (key === previous) {
      WarnSkipped(plan, step, "the catalog did not change after it ran");
      skipped.add(step.target);
      continue;
    }
    try {
      await session.apply(step.sql);
      steps += 1;
    } catch (err) {
      attempts += 1;
      const recovery = Recover(FailureOf(err), attempts);
      if (recovery === "stop") {
        throw err;
      }
      if (recovery === "retry") {
        await delay(RetryDelayMs(attempts));
        continue;
      }
      if (recovery === "skip") {
        WarnSkipped(plan, step, err);
        skipped.add(step.target);
      }
    }
    attempts = 0;
    previous = key;
  }
}

function DeclaresUnique(plan: TablePlan): boolean {
  return plan.indexes.some((index) => index.unique);
}

/** Whether the catalog already holds every unique index the plans declare. */
async function HoldsEveryUniqueIndex(
  session: ConvergenceSession,
  plans: readonly TablePlan[],
): Promise<boolean> {
  for (const plan of plans.filter(DeclaresUnique)) {
    if (!HoldsUniqueIndexes(plan, await Observe(session, plan.table))) {
      return false;
    }
  }
  return true;
}

/** The pause before attempt `attempt + 1` at an index phase the server stopped. */
function RestartDelayMs(attempt: number): number {
  return Math.min(RESTART_FIRST_MS * 2 ** (attempt - 1), RESTART_MAX_MS);
}

/** One attempt at the index phase, on a connection of its own under the schema's indexes lock. */
async function AttemptIndexPhase(
  schemaId: string,
  plans: readonly TablePlan[],
  holdsUnique: () => void,
  build: IndexBuild,
): Promise<void> {
  const isStopping = () => build.stop.signal.aborted;
  const opened = async (session: ConvergenceSession) => {
    if (await HoldsEveryUniqueIndex(session, plans)) {
      holdsUnique();
    }
  };
  const steps = await WithIndexesLock(
    SchemaKey(schemaId),
    { opened, stop: build.stop.signal },
    async (session) => {
      build.session = session;
      try {
        let total = 0;
        for (const plan of plans) {
          total += await ConvergeIndexes(session, plan, isStopping);
        }
        return total;
      } finally {
        build.session = undefined;
      }
    },
  );
  if (steps) {
    Logger.Info(
      `converged the indexes of schema '${schemaId}' in ${steps} statements`,
    );
  }
}

/**
 * Runs the index phase until it ends, starting it again on a connection of the pool each time the
 * server stops it, after a pause of {@link RESTART_FIRST_MS} doubled at each attempt up to
 * {@link RESTART_MAX_MS}, with no limit on attempts. The pool replaces a lost connection, so a
 * server restart, a network drop or a `KILL` only delays the build, and the writes the unique gate
 * holds wait for it. A disconnect of the adapter ends the phase; any other failure rejects.
 */
async function RunIndexPhase(
  schemaId: string,
  plans: readonly TablePlan[],
  holdsUnique: () => void,
): Promise<void> {
  const build: IndexBuild = { stop: new AbortController() };
  builds.add(build);
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await AttemptIndexPhase(schemaId, plans, holdsUnique, build);
        return;
      } catch (err) {
        if (build.stop.signal.aborted) {
          return;
        }
        if (!STOPPED_BY_SERVER.has(FailureOf(err))) {
          throw err;
        }
        const pause = RestartDelayMs(attempt);
        Logger.Warn(
          `The server stopped attempt ${attempt} at the index phase of schema '${schemaId}' (${Describe(err)}); attempt ${attempt + 1} starts on a connection of the pool in ${pause} ms`,
        );
        await PauseUnlessStopped(pause, build.stop.signal);
      }
    }
  } finally {
    builds.delete(build);
  }
}

/** A background index phase, and the gate of the writes its schema's unique indexes guard. */
export interface IndexPhase {
  /** Settles once the phase has, whatever its outcome; never rejects. */
  readonly done: Promise<void>;
  /**
   * Settles at once for plans that declare no unique index, as soon as the phase finds the catalog
   * already holding every one they declare, and otherwise once the phase has settled.
   */
  readonly unique: Promise<void>;
}

/**
 * Converges a schema's secondary indexes and key columns, once its tables converged. Meant to run in
 * the background: queries never wait for it, and their results never depend on whether an index
 * exists yet. `done` never rejects; a failure is logged and repaired by the next registration. A
 * build the server stops, with its statement or its connection, starts again on the pool instead.
 *
 * A btree index builds with writes flowing, and carries its signature from the statement that
 * builds it, so there is no unsigned window and a failed build leaves no index behind. Processes
 * take turns at the phase through a per-schema lock: one that finds it held waits for the holder,
 * then reads the catalog and builds what is left.
 */
export function BuildIndexes(
  schemaId: string,
  plans: readonly TablePlan[],
): IndexPhase {
  let open = () => {};
  const unique = new Promise<void>((resolve) => {
    open = resolve;
  });
  if (!plans.some(DeclaresUnique)) {
    open();
  }
  const done = RunIndexPhase(schemaId, plans, open)
    .catch((err: unknown) => {
      Logger.Error(
        `Building the indexes of schema '${schemaId}' failed; the next registration retries it`,
        err,
      );
    })
    .finally(open);
  phases.add(done);
  void done.finally(() => phases.delete(done));
  return { done, unique };
}

/** Stops every running index build, killing its statement, and waits for each to give its connection back. */
async function StopIndexBuilds(): Promise<void> {
  const running = [...builds];
  for (const build of running) {
    build.stop.abort();
  }
  await Promise.allSettled(
    running.flatMap((build) =>
      build.session ? [Interrupt(build.session)] : [],
    ),
  );
  await Promise.allSettled(phases);
}

RegisterBeforeDisconnect(StopIndexBuilds);
