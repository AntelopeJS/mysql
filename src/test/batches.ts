import type { Stream } from "@antelopejs/interface-database";

import { GetOptions, type Options } from "../config";
import { Reconnect } from "./tables";

/** The rows a cursor handed over, in order, and what it ended with: nothing, or its failure. */
export interface HandedOver<T> {
  readonly rows: readonly T[];
  readonly failure?: unknown;
}

/** Reads `query` through a cursor to its end or its failure, keeping each row it handed over. */
export async function HandedOver<T>(query: Stream<T>): Promise<HandedOver<T>> {
  const rows: T[] = [];
  try {
    for await (const row of query) {
      rows.push(row);
    }
    return { rows };
  } catch (failure) {
    return { rows, failure };
  }
}

/**
 * Reconnects with a cursor batch of one row for the tests of the enclosing `describe`, so a cursor
 * over more than one row hands each row over before it reads the next, and reconnects as before
 * after them.
 */
export function InBatchesOfOne(): void {
  let restore: Options | undefined;
  before(async () => {
    restore = GetOptions();
    await Reconnect({ ...restore, cursorBatchSize: 1 });
  });
  after(async () => {
    if (restore) {
      await Reconnect(restore);
    }
  });
}
