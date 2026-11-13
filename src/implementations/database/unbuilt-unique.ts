import { Logger } from "../../logger";
import type { DdlFailure } from "../../dialect";
import type { IndexPlan, TablePlan } from "./plan";
import type { IndexStep } from "./convergence";

/**
 * Why a declared unique index is not built. `refused`: the server refused it on a live session, such
 * as over rows that already hold duplicates, and a later registration's phase tries again. `locked`:
 * its build kept timing out on a metadata lock, as while a long transaction holds the table, and the
 * phase tries again until it is built.
 */
export type UnbuiltCause = "refused" | "locked";

/**
 * A declared unique index the index phase left unbuilt, with the server's message. The writes it
 * would check are refused until it is built.
 */
export interface UnbuiltUniqueIndex {
  readonly tableId: string;
  readonly index: IndexPlan;
  readonly cause: UnbuiltCause;
  readonly reason: string;
}

/** The unique indexes a schema's writes are refused over, as its index phase finds them now. */
export interface UniqueGate {
  readonly unbuilt: readonly UnbuiltUniqueIndex[];
}

const CAUSES: Partial<Record<DdlFailure, UnbuiltCause>> = {
  refused: "refused",
  lockTimeout: "locked",
};

/** The declared unique index a failed step builds, when the failure leaves it unbuilt for now. */
export function UnbuiltUnique(
  plan: TablePlan,
  step: IndexStep,
  failure: DdlFailure,
  reason: string,
): UnbuiltUniqueIndex | undefined {
  const builds = step.kind === "addIndex" || step.kind === "swapIndex";
  const index = plan.indexes.find(
    (planned) => planned.unique && planned.name === step.target,
  );
  const cause = Object.hasOwn(CAUSES, failure) ? CAUSES[failure] : undefined;
  return builds && index && cause
    ? { tableId: plan.tableId, index, cause, reason }
    : undefined;
}

export function IsLocked(unbuilt: UnbuiltUniqueIndex): boolean {
  return unbuilt.cause === "locked";
}

function Key(unbuilt: UnbuiltUniqueIndex): string {
  return `${unbuilt.tableId}\u0000${unbuilt.index.name}`;
}

/** What follows a unique index the phase left unbuilt, by why. */
const OUTLOOK: Record<UnbuiltCause, string> = {
  refused: "remove the rows it refuses, then register the schema again",
  locked: "it is tried again until the transaction that holds the table ends",
};

/**
 * Logs each unique index a pass left unbuilt that the one before it had not, and each that a pass
 * built after a lock held it off.
 */
export function ReportUnbuilt(
  schemaId: string,
  before: readonly UnbuiltUniqueIndex[],
  after: readonly UnbuiltUniqueIndex[],
): void {
  const was = new Set(before.map(Key));
  const is = new Set(after.map(Key));
  for (const one of after.filter((left) => !was.has(Key(left)))) {
    Logger.Warn(
      `Index phase of '${schemaId}.${one.tableId}' could not build unique index '${one.index.id}': ${one.reason}. Inserts, and writes that set its fields, are refused until it is built: ${OUTLOOK[one.cause]}`,
    );
  }
  for (const one of before.filter((left) => !is.has(Key(left)))) {
    if (IsLocked(one)) {
      Logger.Info(
        `built unique index '${one.index.id}' of '${schemaId}.${one.tableId}' once the lock that held it off was released; writes that set its fields go through again`,
      );
    }
  }
}
