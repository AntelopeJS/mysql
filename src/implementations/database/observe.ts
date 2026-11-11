import type { ObservedTable } from "../../dialect";
import { GetDialect } from "../../connection";
import type { ConvergenceSession } from "./locks";

/**
 * Reads a table's columns, secondary indexes and triggers out of the catalog, or `undefined` when
 * nothing sits at its name. It reads through the session that converges the table, so it sees what
 * that session's last statement left, and a one-connection pool never waits on itself.
 */
export async function Observe(
  session: ConvergenceSession,
  table: string,
): Promise<ObservedTable | undefined> {
  const { catalog } = GetDialect();
  const found = await session.read(catalog.readTable(table));
  if (found.length === 0) {
    return undefined;
  }
  const columns = await session.read(catalog.readColumns(table));
  const indexes = await session.read(catalog.readIndexes(table));
  const triggers = await session.read(catalog.readTriggers(table));
  return catalog.parseTable(found, columns, indexes, triggers);
}
