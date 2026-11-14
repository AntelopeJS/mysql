import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import type { Dialect } from "./dialect";
import { Bind, type Sql } from "./statement";

/** A warning the server raised, as the error a statement that failed for it would have raised. */
class ServerWarning extends Error {
  constructor(
    readonly errno: number,
    message: string,
  ) {
    super(message);
  }
}

/** A read whose aggregate the engine cut short at `max_allowed_packet`, so its answer is not whole. */
class AggregateTooLarge extends Error {
  constructor(warning: ServerWarning) {
    super(
      `MariaDB cut an aggregate of the read short at max_allowed_packet, so the read cannot answer whole; raise max_allowed_packet on the server (${warning.message}, errno ${warning.errno})`,
    );
  }
}

/** A row of the engine's warnings listing, read only through the two columns it names. */
interface ListedWarning extends RowDataPacket {
  readonly Code: unknown;
  readonly Message: unknown;
}

async function Warnings(
  connection: PoolConnection,
  listing: Sql,
): Promise<ServerWarning[]> {
  const bound = Bind(listing);
  const [listed] = await connection.execute<ListedWarning[]>(bound.sql, [
    ...bound.args,
  ]);
  return listed.map(
    (warning) =>
      new ServerWarning(Number(warning.Code), String(warning.Message)),
  );
}

async function Clear(connection: PoolConnection, clear: Sql): Promise<void> {
  const bound = Bind(clear);
  await connection.execute(bound.sql, [...bound.args]);
}

/**
 * The error the statement that just failed on `connection` with `failure` stands for. MariaDB lists
 * a cut aggregate's warning beside the error a later read of its cut JSON raised, so a server error
 * is reported as the cut that caused it. Strict mode fails an `UPDATE` with the too-deep error that
 * a read only warns of. MariaDB keeps either listed through statements that read no table, so
 * either is cleared. A lost connection, a deadlock or a lock wait keeps its own error, as does
 * every failure on an engine that lists no warnings.
 */
export async function CutBehind(
  connection: PoolConnection,
  { capture, errors }: Dialect,
  failure: Error,
): Promise<Error> {
  if (!capture.warnings || errors.classify(failure).kind !== "server") {
    return failure;
  }
  const listed = await Warnings(connection, capture.warnings.list).catch(
    () => [],
  );
  const cut = listed.find((warning) => capture.cutAggregate(warning));
  if (cut || listed.some((warning) => capture.tooDeep(warning))) {
    await Clear(connection, capture.warnings.clear);
  }
  return cut ? new AggregateTooLarge(cut) : failure;
}

/**
 * The error the statement that just answered on `connection` fails with, from the warnings MariaDB
 * listed for it: an aggregate cut at `max_allowed_packet`, or else a JSON document nested deeper
 * than the engine builds. It clears the warnings it fails with, so the next statement on the
 * connection does not inherit them. `undefined` when the answer is whole, and always on an engine
 * that lists no warnings.
 */
export async function WarnedFailure(
  connection: PoolConnection,
  { capture }: Dialect,
): Promise<Error | undefined> {
  if (!capture.warnings) {
    return undefined;
  }
  const warnings = await Warnings(connection, capture.warnings.list);
  const cut = warnings.find((warning) => capture.cutAggregate(warning));
  const warned = cut
    ? new AggregateTooLarge(cut)
    : warnings.find((warning) => capture.tooDeep(warning));
  if (warned) {
    await Clear(connection, capture.warnings.clear);
  }
  return warned;
}
