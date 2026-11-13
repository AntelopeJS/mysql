import { Logger } from "../../logger";
import type { DdlFailure } from "../../dialect";
import {
  GetDialect,
  IsPoolEnding,
  RegisterBeforeDisconnect,
} from "../../connection";
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
  type FailedAttempt,
  FailureOf,
  Interrupt,
  LOCK_ATTEMPTS,
  PauseUnlessStopped,
  RetryDelayMs,
  WithIndexesLock,
} from "./locks";
import {
  IsLocked,
  ReportUnbuilt,
  type UnbuiltUniqueIndex,
  UnbuiltUnique,
  type UniqueGate,
} from "./unbuilt-unique";

/** What one table's index phase did: the statements it ran, and the unique indexes it left unbuilt. */
interface Converged {
  readonly steps: number;
  readonly unbuilt: readonly UnbuiltUniqueIndex[];
}

/**
 * A later pass at a table's indexes, which tries again the unique indexes a lock held off: each step
 * gets one attempt, a failure is not logged again, and the indexes the server refused are left alone.
 */
interface Retry {
  readonly refused: ReadonlySet<string>;
}

/**
 * A running index phase: the schema it builds, the session it builds on while it holds the lock,
 * and what stops it.
 */
interface IndexBuild {
  readonly schemaId: string;
  session?: ConvergenceSession;
  readonly stop: AbortController;
}

const INDEX_BUILD_STOPPED = new Error(
  "MySQL index build stopped: the adapter is disconnecting",
);

/** The pause before an index phase the server stopped starts again, doubled at each attempt. */
const RESTART_FIRST_MS = 1000;

/**
 * The longest pause between two attempts at an index phase the server keeps stopping, or between two
 * passes at a unique index a lock keeps holding off.
 */
const RESTART_MAX_MS = 30_000;

/**
 * How the server stops a build without refusing it: a killed statement, as a shutdown or `KILL QUERY`
 * stops it, or an ended connection, as a restart, a network drop or `KILL` ends it.
 */
const STOPPED_BY_SERVER: ReadonlySet<DdlFailure> = new Set([
  "interrupted",
  "disconnected",
]);

/**
 * How long a later pass's statement waits for a metadata lock, shorter than the first pass's: every
 * statement on the table queues behind it, at each pass, for as long as the transaction holds it.
 */
const RETRY_LOCK_WAIT_SECONDS = 1;

const builds = new Set<IndexBuild>();
const phases = new Set<Promise<IndexPhaseEnd>>();

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

function Recover(
  failure: DdlFailure,
  attempts: number,
  lockAttempts: number,
): Recovery {
  if (failure === "lockTimeout" && attempts < lockAttempts) {
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

/** The pause before attempt `attempt + 1` at an index phase the server stopped. */
function RestartDelayMs(attempt: number): number {
  return Math.min(RESTART_FIRST_MS * 2 ** (attempt - 1), RESTART_MAX_MS);
}

/**
 * The `again` hook of a schema's index phase: tries again each time the server stops an attempt,
 * with its statement or its connection, or the pool cannot hand one out at all, after a pause of
 * {@link RESTART_FIRST_MS} doubled at each attempt up to {@link RESTART_MAX_MS}, with no limit on
 * attempts. A server restart, a network drop, a `KILL` or a server turning connections away thus
 * only delays an index build, and the writes the unique gate holds wait for it. Gives up on any
 * other failure, and once `stop` aborts.
 */
function AgainWhenServerStops(
  schemaId: string,
  stop: AbortSignal,
): (failed: FailedAttempt) => Promise<boolean> {
  let attempt = 0;
  return async ({ cause, connected }) => {
    if (
      stop.aborted ||
      (connected && !STOPPED_BY_SERVER.has(FailureOf(cause)))
    ) {
      return false;
    }
    attempt += 1;
    const pause = RestartDelayMs(attempt);
    Logger.Warn(
      `The server stopped attempt ${attempt} at the index phase of schema '${schemaId}' (${Describe(cause)}); attempt ${attempt + 1} starts on a connection of the pool in ${pause} ms`,
    );
    await PauseUnlessStopped(pause, stop);
    return true;
  };
}

/**
 * Brings one table's indexes and key columns in line with its plan, one statement at a time,
 * reading the catalog again before each. A statement the server refuses, such as a unique index over
 * duplicates, or one that keeps timing out on a lock, is left for later while the others proceed; a
 * unique index left so is answered among `unbuilt`, and any other step is logged. A killed
 * statement, a broken session or `stop` ends this attempt at the phase.
 */
export async function ConvergeIndexes(
  session: ConvergenceSession,
  plan: TablePlan,
  stop: AbortSignal,
  retry?: Retry,
): Promise<Converged> {
  const lockAttempts = retry ? 1 : LOCK_ATTEMPTS;
  const skipped = new Set<string>(retry?.refused);
  const unbuilt: UnbuiltUniqueIndex[] = [];
  let steps = 0;
  let attempts = 0;
  let previous: string | undefined;
  for (;;) {
    if (stop.aborted) {
      throw INDEX_BUILD_STOPPED;
    }
    const observed = await Observe(session, plan.table);
    const step =
      observed && NextIndexStep(GetDialect(), plan, observed, skipped);
    if (!step) {
      return { steps, unbuilt };
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
      const failure = FailureOf(err);
      const recovery = Recover(failure, attempts, lockAttempts);
      if (recovery === "stop") {
        throw err;
      }
      if (recovery === "retry") {
        await PauseUnlessStopped(RetryDelayMs(attempts), stop);
        continue;
      }
      if (recovery === "skip") {
        const left = UnbuiltUnique(plan, step, failure, Describe(err));
        if (left) {
          unbuilt.push(left);
        } else if (!retry) {
          WarnSkipped(plan, step, err);
        }
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

/** How an index phase ended: it ran to its end, it failed, or a disconnect stopped it first. */
export type IndexPhaseEnd = "converged" | "failed" | "stopped";

/** Opens a schema's unique gate, or updates it, answering the unique indexes left unbuilt. */
type OpenUniqueGate = (unbuilt: readonly UnbuiltUniqueIndex[]) => void;

/** One pass at the indexes of `plans` under the schema's indexes lock. */
async function RunPass(
  build: IndexBuild,
  plans: readonly TablePlan[],
  hooks: Parameters<typeof WithIndexesLock>[1],
  previous: readonly UnbuiltUniqueIndex[] | undefined,
): Promise<Converged> {
  const refused = (plan: TablePlan): Retry | undefined =>
    previous && {
      refused: new Set(
        previous
          .filter((one) => !IsLocked(one) && one.tableId === plan.tableId)
          .map((one) => one.index.name),
      ),
    };
  return WithIndexesLock(SchemaKey(build.schemaId), hooks, async (session) => {
    build.session = session;
    try {
      if (previous) {
        await session.apply(GetDialect().ddl.lockWait(RETRY_LOCK_WAIT_SECONDS));
      }
      let steps = 0;
      const unbuilt: UnbuiltUniqueIndex[] = [];
      for (const plan of plans) {
        const table = await ConvergeIndexes(
          session,
          plan,
          build.stop.signal,
          refused(plan),
        );
        steps += table.steps;
        unbuilt.push(...table.unbuilt);
      }
      return { steps, unbuilt };
    } finally {
      build.session = undefined;
    }
  });
}

/**
 * Runs passes at a schema's indexes: the first over every table, and while a lock holds off a unique
 * index, another over the tables of such indexes, after a pause of {@link RESTART_FIRST_MS} doubled
 * at each pass up to {@link RESTART_MAX_MS}. Each pass takes the indexes lock and gives it back, so
 * another process's phase takes its turn between two.
 */
async function RunIndexPhase(
  schemaId: string,
  plans: readonly TablePlan[],
  open: OpenUniqueGate,
): Promise<"converged" | "stopped"> {
  if (IsPoolEnding()) {
    return "stopped";
  }
  const build: IndexBuild = { schemaId, stop: new AbortController() };
  builds.add(build);
  const stop = build.stop.signal;
  try {
    const again = AgainWhenServerStops(schemaId, stop);
    const opened = async (session: ConvergenceSession) => {
      if (await HoldsEveryUniqueIndex(session, plans)) {
        open([]);
      }
    };
    const first = await RunPass(
      build,
      plans,
      { opened, stop, again },
      undefined,
    );
    let { steps, unbuilt } = first;
    ReportUnbuilt(schemaId, [], unbuilt);
    open(unbuilt);
    for (let pass = 1; unbuilt.some(IsLocked); pass++) {
      await PauseUnlessStopped(RestartDelayMs(pass), stop);
      const tables = plans.filter((plan) =>
        unbuilt.some((one) => IsLocked(one) && one.tableId === plan.tableId),
      );
      const converged = await RunPass(build, tables, { stop, again }, unbuilt);
      steps += converged.steps;
      const next = [
        ...unbuilt.filter((one) => !IsLocked(one)),
        ...converged.unbuilt,
      ];
      ReportUnbuilt(schemaId, unbuilt, next);
      unbuilt = next;
      open(unbuilt);
    }
    if (steps) {
      Logger.Info(
        `converged the indexes of schema '${schemaId}' in ${steps} statements`,
      );
    }
    return "converged";
  } catch (err) {
    if (!stop.aborted) {
      throw err;
    }
    return "stopped";
  } finally {
    builds.delete(build);
  }
}

/** A background index phase, and the gate of the writes its schema's unique indexes guard. */
export interface IndexPhase {
  /** Settles once the phase has, to how it ended; never rejects. */
  readonly done: Promise<IndexPhaseEnd>;
  /**
   * Settles at once for plans that declare no unique index, as soon as the phase finds the catalog
   * already holding every one they declare, and otherwise once the phase's first pass has ended or
   * the phase has settled. Its `unbuilt` then follows the unique indexes left unbuilt, as later
   * passes build them. Rejects when a disconnect stops the phase before that, so no write it holds
   * runs on the pool being ended.
   */
  readonly unique: Promise<UniqueGate>;
}

/**
 * Converges a schema's secondary indexes and key columns, once its tables converged. Meant to run in
 * the background: queries never wait for it, and their results never depend on whether an index
 * exists yet. `done` never rejects; a failure is logged and repaired by the next registration, and
 * a phase a disconnect stopped is run again by the registration the next pool makes.
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
  let current: readonly UnbuiltUniqueIndex[] = [];
  const gate: UniqueGate = {
    get unbuilt() {
      return current;
    },
  };
  let resolve: (gate: UniqueGate) => void = () => {};
  let refuse: (reason: Error) => void = () => {};
  const unique = new Promise<UniqueGate>((settle, reject) => {
    resolve = settle;
    refuse = reject;
  });
  unique.catch(() => {});
  const open: OpenUniqueGate = (unbuilt) => {
    current = unbuilt;
    resolve(gate);
  };
  if (!plans.some(DeclaresUnique)) {
    open([]);
  }
  const done = RunIndexPhase(schemaId, plans, open)
    .catch((err: unknown) => {
      Logger.Error(
        `Building the indexes of schema '${schemaId}' failed; the next registration retries it`,
        err,
      );
      return "failed" as const;
    })
    .then((end) => {
      if (end === "stopped") {
        refuse(INDEX_BUILD_STOPPED);
      }
      resolve(gate);
      return end;
    });
  phases.add(done);
  void done.finally(() => phases.delete(done));
  return { done, unique };
}

/** Stops each build, killing the statement it runs, and waits for the kills to land. */
async function Stop(running: readonly IndexBuild[]): Promise<void> {
  for (const build of running) {
    build.stop.abort();
  }
  await Promise.allSettled(
    running.flatMap((build) =>
      build.session ? [Interrupt(build.session)] : [],
    ),
  );
}

function BuildsOf(schemaId: string): IndexBuild[] {
  return [...builds].filter((build) => build.schemaId === schemaId);
}

/**
 * Stops the index phases of a schema, running or waiting for their turn, as unregistering it does:
 * nothing waits for them any more, and a phase that a lock holds off would otherwise keep trying for
 * as long as the lock is held.
 */
export async function StopSchemaIndexBuilds(schemaId: string): Promise<void> {
  await Stop(BuildsOf(schemaId));
}

/**
 * Ends the index phases of a schema once the statement each runs has ended, as a later registration
 * of the schema does before it starts its own phase: that phase builds from the plan now declared,
 * and a build it still declares is not thrown away.
 */
export function SupersedeIndexBuilds(schemaId: string): void {
  for (const build of BuildsOf(schemaId)) {
    build.stop.abort();
  }
}

/**
 * Stops every running index build, killing its statement, and waits for each to give its connection
 * back. A phase that would start on the pool being ended stops before it runs.
 */
async function StopIndexBuilds(): Promise<void> {
  await Stop([...builds]);
  await Promise.allSettled(phases);
}

RegisterBeforeDisconnect(StopIndexBuilds);
