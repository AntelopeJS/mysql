import type { QueryStage } from "@antelopejs/interface-database/common";

/**
 * Refuses every query, naming this module. The query compiler replaces this file; until then a
 * refusal that names the module proves a caller's interface call reached this implementation.
 */
function NotImplemented(operation: string): Error {
  return new Error(`${operation} is not implemented by @antelopejs/mysql yet`);
}

export async function RunQuery(stages: QueryStage[]): Promise<never> {
  throw NotImplemented(`RunQuery (${stages.length} stages)`);
}

export async function ReadCursor(
  reqId: number,
  stages: QueryStage[],
): Promise<never> {
  throw NotImplemented(`ReadCursor #${reqId} (${stages.length} stages)`);
}

export async function CloseCursor(reqId: number): Promise<void> {
  throw NotImplemented(`CloseCursor #${reqId}`);
}
