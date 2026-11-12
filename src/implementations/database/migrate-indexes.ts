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
  RetryDelayMs,
  WithIndexesLock,
} from "./locks";

/** A running index phase: the session it builds on, once it holds the lock, and whether to stop. */
interface IndexBuild {
  session?: ConvergenceSession;
  isStopping: boolean;
}

const INDEX_BUILD_STOPPED = new Error(
  "MySQL index build stopped: the adapter is disconnecting",
);

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
 * statement or a broken session ends the phase.
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

async function RunIndexPhase(
  schemaId: string,
  plans: readonly TablePlan[],
  holdsUnique: () => void,
): Promise<void> {
  const build: IndexBuild = { isStopping: false };
  builds.add(build);
  const isStopping = () => build.isStopping;
  try {
    const opened = async (session: ConvergenceSession) => {
      build.session = session;
      if (await HoldsEveryUniqueIndex(session, plans)) {
        holdsUnique();
      }
    };
    const steps = await WithIndexesLock(
      SchemaKey(schemaId),
      { opened, isStopping },
      async (session) => {
        let total = 0;
        for (const plan of plans) {
          total += await ConvergeIndexes(session, plan, isStopping);
        }
        return total;
      },
    );
    if (steps) {
      Logger.Info(
        `converged the indexes of schema '${schemaId}' in ${steps} statements`,
      );
    }
  } catch (err) {
    if (!build.isStopping) {
      throw err;
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
 * exists yet. `done` never rejects; a failure is logged and repaired by the next registration.
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
    build.isStopping = true;
  }
  await Promise.allSettled(
    running.flatMap((build) =>
      build.session ? [Interrupt(build.session)] : [],
    ),
  );
  await Promise.allSettled(phases);
}

RegisterBeforeDisconnect(StopIndexBuilds);
