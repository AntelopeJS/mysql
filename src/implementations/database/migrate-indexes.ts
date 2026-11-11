import { setTimeout as delay } from "node:timers/promises";

import { Logger } from "../../logger";
import type { DdlFailure } from "../../dialect";
import { GetDialect, RegisterBeforeDisconnect } from "../../connection";
import { Observe } from "./observe";
import { SchemaKey } from "./registry";
import type { TablePlan } from "./plan";
import { type IndexStep, NextIndexStep } from "./convergence";
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

async function RunIndexPhase(
  schemaId: string,
  plans: readonly TablePlan[],
): Promise<void> {
  const build: IndexBuild = { isStopping: false };
  builds.add(build);
  try {
    const steps = await WithIndexesLock(
      SchemaKey(schemaId),
      async (session) => {
        build.session = session;
        let total = 0;
        for (const plan of plans) {
          total += await ConvergeIndexes(session, plan, () => build.isStopping);
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

/**
 * Converges a schema's secondary indexes and key columns, once its tables converged. Meant to run in
 * the background: queries never wait for it, and their results never depend on whether an index
 * exists yet. The answer never rejects; a failure is logged and repaired by the next registration.
 *
 * A btree index builds with writes flowing, and carries its signature from the statement that
 * builds it, so there is no unsigned window and a failed build leaves no index behind. Processes
 * share the phase through a per-schema lock that is only ever tried: when another session holds it,
 * that session is building the same indexes and this phase does nothing.
 */
export function BuildIndexes(
  schemaId: string,
  plans: readonly TablePlan[],
): Promise<void> {
  const phase = RunIndexPhase(schemaId, plans).catch((err: unknown) => {
    Logger.Error(
      `Building the indexes of schema '${schemaId}' failed; the next registration retries it`,
      err,
    );
  });
  phases.add(phase);
  void phase.finally(() => phases.delete(phase));
  return phase;
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
