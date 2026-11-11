import { createHash } from "node:crypto";

import { Bind, type Sql } from "../../statement";
import type { CapturedColumn, ChangeOperation, Dialect } from "../../dialect";
import { GetDialect, RegisterBeforeDisconnect } from "../../connection";
import { Observe } from "./observe";
import type { TablePlan } from "./plan";
import { CHANGE_LOG, SchemaKey } from "./registry";
import { type ConvergenceSession, WithTablesLock } from "./locks";
import { OPAQUE, type SqlType, TEXT } from "./types";

/** Every trigger this module makes for capture starts with it, and no other trigger may. */
const TRIGGER_PREFIX = "ajs_chg_";

const SIGNATURE_CHARS = 16;

const OPERATION_SUFFIXES: Record<ChangeOperation, string> = {
  added: "_i",
  modified: "_u",
  removed: "_d",
};

const SUFFIXES = Object.values(OPERATION_SUFFIXES);

/** One trigger a table's plan wants: its name, which carries its signature, and its statement. */
interface Trigger {
  readonly name: string;
  readonly create: Sql;
}

/**
 * A change to one table's triggers. The new triggers are created before the old ones are dropped,
 * all while `lock` holds the table, so no write runs between them and a crash part way leaves a
 * trigger twice rather than none. `refusal` words a statement the server refused for want of a
 * privilege or a setting.
 */
export interface TriggerSwap {
  readonly lock: Sql;
  readonly statements: readonly Sql[];
  readonly unlock: Sql;
  readonly refusal: (error: Error) => string | undefined;
}

/**
 * Who asks for a swap. Convergence keeps a watched table's triggers in step with its plan, and
 * leaves an unwatched table alone. A feed installs them on a table that lacks a trigger for some
 * operation, and otherwise accepts what is there: in a rolling deploy, a process with an older
 * plan must not swap back the triggers a newer one converged.
 */
type SwapIntent = "converge" | "install";

function ColumnType(column: TablePlan["columns"][number]): SqlType {
  switch (column.role) {
    case "id":
    case "instance":
      return TEXT;
    case "extra":
      return OPAQUE;
    case "declared":
      return column.type;
  }
}

/** The columns an image holds: every stored column. A key column is derived from them, so it is left out. */
function CapturedColumns(plan: TablePlan): CapturedColumn[] {
  return plan.columns.map((column) => ({
    name: column.name,
    type: ColumnType(column),
  }));
}

/**
 * The triggers that log a table's writes, as its plan wants them. Each name carries a digest of
 * the three bodies, which name the table and every column they read, so a body that changes for
 * any reason is a trigger of another name and the swap that replaces it is planned from names alone.
 */
function DesiredTriggers(dialect: Dialect, plan: TablePlan): Trigger[] {
  const { capture } = dialect;
  const bodies = capture.triggers(
    CHANGE_LOG,
    plan.table,
    CapturedColumns(plan),
  );
  const digest = createHash("sha256")
    .update(JSON.stringify(bodies.map((trigger) => Bind(trigger.body))))
    .digest("hex")
    .slice(0, SIGNATURE_CHARS);
  return bodies.map((trigger) => {
    const name = `${TRIGGER_PREFIX}${digest}${OPERATION_SUFFIXES[trigger.operation]}`;
    return { name, create: capture.createTrigger(name, plan.table, trigger) };
  });
}

function IsCaptureTrigger(name: string): boolean {
  return name.startsWith(TRIGGER_PREFIX);
}

/** Whether every operation has one of the module's triggers, whatever plan made it. */
function CoversEveryOperation(ours: readonly string[]): boolean {
  return SUFFIXES.every((suffix) => ours.some((name) => name.endsWith(suffix)));
}

/**
 * Pure. The swap that leaves exactly the plan's triggers on a table that has `observed`, or none
 * when there is nothing to do for `intent`.
 */
export function PlanTriggerSwap(
  dialect: Dialect,
  plan: TablePlan,
  observed: readonly string[],
  intent: SwapIntent,
): TriggerSwap | undefined {
  const ours = observed.filter(IsCaptureTrigger);
  const isNeeded =
    intent === "converge" ? ours.length > 0 : !CoversEveryOperation(ours);
  if (!isNeeded) {
    return undefined;
  }
  const desired = DesiredTriggers(dialect, plan);
  const wanted = new Set(desired.map((trigger) => trigger.name));
  const present = new Set(ours);
  const create = desired.filter((trigger) => !present.has(trigger.name));
  const drop = ours.filter((name) => !wanted.has(name));
  if (create.length === 0 && drop.length === 0) {
    return undefined;
  }
  return {
    lock: dialect.capture.lockTable(plan.table),
    statements: [
      ...create.map((trigger) => trigger.create),
      ...drop.map((name) => dialect.capture.dropTrigger(name)),
    ],
    unlock: dialect.capture.unlockTables,
    refusal: (error) => dialect.capture.triggerRefusal(error),
  };
}

/** Words a refusal the server gave for want of a privilege or a setting, keeping the server's error as its cause. */
function Explained(swap: TriggerSwap, error: Error): Error {
  const reason = swap.refusal(error);
  return reason === undefined ? error : new Error(reason, { cause: error });
}

/**
 * Runs a swap on `session`, giving the table back however the swap ends. A statement the server
 * refuses for want of a privilege or a setting fails with what the caller can do about it.
 */
export async function ApplyTriggerSwap(
  session: ConvergenceSession,
  swap: TriggerSwap,
): Promise<void> {
  await session.apply(swap.lock);
  try {
    for (const statement of swap.statements) {
      try {
        await session.apply(statement);
      } catch (error) {
        throw error instanceof Error ? Explained(swap, error) : error;
      }
    }
  } finally {
    await session.apply(swap.unlock);
  }
}

const installs = new Map<string, Promise<void>>();

async function Install(plan: TablePlan): Promise<void> {
  const dialect = GetDialect();
  await WithTablesLock(SchemaKey(plan.schemaId), async (session) => {
    const observed = await Observe(session, plan.table);
    if (!observed) {
      throw new Error(
        `Table '${plan.table}' of '${plan.schemaId}.${plan.tableId}' does not exist, so its changes cannot be captured`,
      );
    }
    const swap = PlanTriggerSwap(dialect, plan, observed.triggers, "install");
    if (swap) {
      await ApplyTriggerSwap(session, swap);
    }
  });
}

/**
 * Installs a table's triggers once per process, the first time a feed opens on it; from then on the
 * table is watched, and every convergence keeps its triggers in step with its columns.
 *
 * One install is shared by every feed that asks at once. A failed one is forgotten, so the next
 * feed tries again: remembered, it would leave the table's writes unlogged with nothing failing.
 * It runs under the schema's tables lock, so it never interleaves with a convergence of the table.
 */
export function EnsureTriggers(plan: TablePlan): Promise<void> {
  const known = installs.get(plan.table);
  if (known) {
    return known;
  }
  const install = Install(plan);
  installs.set(plan.table, install);
  install.catch(() => {
    if (installs.get(plan.table) === install) {
      installs.delete(plan.table);
    }
  });
  return install;
}

RegisterBeforeDisconnect(() => {
  installs.clear();
});
