import { setTimeout as delay } from "node:timers/promises";

import { Logger } from "../../logger";
import { GetDialect, type Row } from "../../connection";
import type { MigrationMode } from "../../config";
import type { DdlSyntax, RowKey } from "../../dialect";
import { Observe } from "./observe";
import type { DeclaredColumn, TablePlan } from "./plan";
import { RegistryStatements, SchemaKey } from "./registry";
import { NextTableStep, type TableStep } from "./convergence";
import {
  type ConvergenceSession,
  FailureOf,
  LOCK_ATTEMPTS,
  RetryDelayMs,
  WithTablesLock,
} from "./locks";

/** Rows a backfill statement covers: short enough that no row lock is held long. */
const BACKFILL_CHUNK_ROWS = 1000;

/** What converging one table did, and what it chose to leave in place. */
export interface TableConvergence {
  readonly steps: number;
  readonly warnings: readonly string[];
}

/** How a step ended: applied, found already done, or blocked by a lock it may get later. */
type Outcome = "applied" | "done" | "lockTimeout";

const warned = new Set<string>();

function Describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function StepError(plan: TablePlan, step: TableStep, cause: unknown): Error {
  return new Error(
    `Converging table '${plan.table}' of '${plan.schemaId}.${plan.tableId}' failed at ${step.kind} '${step.target}': ${Describe(cause)}`,
    { cause },
  );
}

function RowKeyOf(row: Row): RowKey {
  return { instance: String(row.get("instance")), id: String(row.get("id")) };
}

/**
 * Moves a declared field out of `_extra` into its column, one key range at a time. The ranges only
 * spare later chunks a rescan: each chunk matches only rows still holding a value the column can
 * take, so a backfill stopped anywhere is finished by running it again from the start.
 */
async function Backfill(
  session: ConvergenceSession,
  ddl: DdlSyntax,
  table: string,
  column: DeclaredColumn,
): Promise<void> {
  let after: RowKey | undefined;
  for (;;) {
    const [bound] = await session.read(
      ddl.backfillBound(table, after, BACKFILL_CHUNK_ROWS),
    );
    const through = bound ? RowKeyOf(bound) : undefined;
    await session.write(ddl.backfillChunk(table, column, after, through));
    if (!through) {
      return;
    }
    after = through;
  }
}

async function Run(
  session: ConvergenceSession,
  plan: TablePlan,
  step: TableStep,
): Promise<void> {
  if (step.kind !== "backfill") {
    await session.apply(step.sql);
    return;
  }
  await Backfill(session, GetDialect().ddl, plan.table, step.column);
  await session.apply(step.settle);
}

async function Attempt(
  session: ConvergenceSession,
  plan: TablePlan,
  step: TableStep,
): Promise<Outcome> {
  try {
    await Run(session, plan, step);
    return "applied";
  } catch (err) {
    const failure = FailureOf(err);
    if (failure === "lockTimeout") {
      return "lockTimeout";
    }
    if (failure === "present" || failure === "absent") {
      return "done";
    }
    throw StepError(plan, step, err);
  }
}

/**
 * Brings one table in line with its plan, one step at a time, reading the catalog again before
 * each: whatever a crash or another process left, the next step is planned from what is there. A
 * step that timed out on a lock is tried again after a pause, up to {@link LOCK_ATTEMPTS} times; a
 * step whose object already exists, or is already gone, counts as done.
 */
export async function ConvergeTable(
  session: ConvergenceSession,
  plan: TablePlan,
  mode: MigrationMode,
): Promise<TableConvergence> {
  let steps = 0;
  let attempts = 0;
  let previous: string | undefined;
  for (;;) {
    const observed = await Observe(session, plan.table);
    const { step, warnings } = NextTableStep(
      GetDialect(),
      mode,
      plan,
      observed,
    );
    if (!step) {
      return { steps, warnings };
    }
    const key = `${step.kind} '${step.target}'`;
    if (key === previous) {
      throw StepError(plan, step, "the catalog did not change after it ran");
    }
    const outcome = await Attempt(session, plan, step);
    if (outcome === "lockTimeout") {
      attempts += 1;
      if (attempts >= LOCK_ATTEMPTS) {
        throw StepError(plan, step, "a lock it needs stayed held");
      }
      await delay(RetryDelayMs(attempts));
      continue;
    }
    steps += outcome === "applied" ? 1 : 0;
    attempts = 0;
    previous = key;
  }
}

function WarnOnce(warnings: readonly string[]): void {
  for (const warning of warnings) {
    if (!warned.has(warning)) {
      warned.add(warning);
      Logger.Warn(warning);
    }
  }
}

/**
 * Brings a registered schema's tables and columns in line with their plans, backfills included;
 * the readiness gate opens when this resolves. The module's registry objects are created first.
 * Processes take turns per schema through its tables lock.
 */
export async function ConvergeTables(
  schemaId: string,
  plans: readonly TablePlan[],
  mode: MigrationMode,
): Promise<void> {
  const report = await WithTablesLock(SchemaKey(schemaId), async (session) => {
    for (const statement of RegistryStatements(GetDialect())) {
      await session.apply(statement);
    }
    let steps = 0;
    const warnings: string[] = [];
    for (const plan of plans) {
      const table = await ConvergeTable(session, plan, mode);
      steps += table.steps;
      warnings.push(...table.warnings);
    }
    return { steps, warnings };
  });
  WarnOnce(report.warnings);
  if (report.steps > 0) {
    Logger.Info(
      `converged the tables of schema '${schemaId}' in ${report.steps} steps`,
    );
  }
}
