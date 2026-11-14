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

/**
 * A write the server refused because its binary log records statements. It keeps the server's
 * errno and SQL state, so it still reads as that refusal and never as a lost connection.
 */
export class BinlogFormatRefusal extends Error {
  readonly errno = 1665;
  readonly sqlState = "HY000";
  readonly code = "ER_BINLOG_STMT_MODE_AND_ROW_ENGINE";

  constructor(cause: Error) {
    super(
      `The server refused the write (errno 1665): its binary log records statements (binlog_format = STATEMENT), and InnoDB logs a write at READ COMMITTED or READ UNCOMMITTED, as this one ran, only as rows. Set binlog_format to ROW or MIXED on the server, the defaults of MySQL and MariaDB (SET GLOBAL binlog_format = 'ROW', and in its configuration file to keep it across a restart); a connection keeps the format it opened with, so restart the application after. See https://dev.mysql.com/doc/refman/8.4/en/binary-log-setting.html`,
      { cause },
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

/** The warnings a read fails on that MariaDB listed for the session's last statement, cleared where it listed one. */
async function Listed(
  connection: PoolConnection,
  capture: Dialect["capture"],
  warnings: NonNullable<Dialect["capture"]["warnings"]>,
): Promise<{
  readonly cut: ServerWarning | undefined;
  readonly deep: ServerWarning | undefined;
  readonly listed: readonly ServerWarning[];
}> {
  const listed = await Warnings(connection, warnings.list).catch(() => []);
  const cut = listed.find((warning) => capture.cutAggregate(warning));
  const deep = listed.find((warning) => capture.tooDeep(warning));
  if (cut || deep) {
    await Clear(connection, warnings.clear);
  }
  return { cut, deep, listed };
}

/**
 * The error the statement that just failed on `connection` with `failure` stands for. MariaDB lists
 * a cut aggregate's warning beside the error a later read of its cut JSON raised, so a server error
 * is reported as the cut that caused it. Strict mode fails an `UPDATE` with the too-deep error that
 * a read only warns of. MariaDB keeps either listed through statements that read no table, so
 * either is cleared. A write the server's statement-format binary log refused is reported as the
 * setting that refused it. A lost connection, a deadlock or a lock wait keeps its own error, as
 * does every failure on an engine that lists no warnings.
 */
export async function CutBehind(
  connection: PoolConnection,
  { capture, errors }: Dialect,
  failure: Error,
): Promise<Error> {
  const { kind } = errors.classify(failure);
  if (kind === "binlogFormat") {
    return new BinlogFormatRefusal(failure);
  }
  if (!capture.warnings || kind !== "server") {
    return failure;
  }
  const { cut } = await Listed(connection, capture, capture.warnings);
  return cut ? new AggregateTooLarge(cut) : failure;
}

/** A read whose statement raised more warnings than MariaDB lists, so none of them can be read as harmless. */
class UnlistedWarnings extends Error {
  constructor(listed: number, raised: number) {
    super(
      `MariaDB raised ${raised} warnings computing the read's rows but lists only ${listed} (max_error_count), so the read cannot tell whether one is a cut aggregate or a document nested too deep`,
    );
  }
}

/** How many warnings and errors MariaDB raised for the session's last statement. */
async function Raised(
  connection: PoolConnection,
  warnings: NonNullable<Dialect["capture"]["warnings"]>,
): Promise<number> {
  const bound = Bind(warnings.count);
  const [counted] = await connection.execute<CountedWarnings[]>(bound.sql, [
    ...bound.args,
  ]);
  return Number(counted[0]?.warnings);
}

/** A row of the engine's warning count, read only through the column it names. */
interface CountedWarnings extends RowDataPacket {
  readonly warnings: unknown;
}

/**
 * What a cursor's statement that `checked` wrote, which just failed on `connection` with
 * `failure`, stands for. A failure at its check is the cut aggregate or the too-deep document
 * MariaDB listed, or, where it listed neither, how many warnings the statement raised, which a
 * second run of it tolerates. Where MariaDB lists fewer warnings than it raised, an unlisted one
 * may be either, so the cursor fails. Any other failure is what {@link CutBehind} reports.
 */
export async function CheckedBehind(
  connection: PoolConnection,
  dialect: Dialect,
  failure: Error,
): Promise<Error | number> {
  const warnings = dialect.capture.warnings;
  if (!warnings?.checkFailed(failure)) {
    return CutBehind(connection, dialect, failure);
  }
  const { cut, deep, listed } = await Listed(
    connection,
    dialect.capture,
    warnings,
  );
  if (cut) {
    return new AggregateTooLarge(cut);
  }
  if (deep) {
    return deep;
  }
  const raised = await Raised(connection, warnings);
  if (!Number.isSafeInteger(raised) || raised <= 1) {
    return failure;
  }
  const tolerated = raised - 1;
  const harmless = listed.filter((warning) => !warnings.checkFailed(warning));
  return harmless.length < tolerated
    ? new UnlistedWarnings(harmless.length, tolerated)
    : tolerated;
}

/**
 * The error the statement that just answered on `connection` fails with, from the warnings MariaDB
 * listed for it: an aggregate cut at `max_allowed_packet`, or else a JSON document nested deeper
 * than the engine builds. Where it lists fewer warnings than the statement raised
 * (`max_error_count`), an unlisted one may be either, so the read fails. It clears the warnings it
 * fails with, so the next statement on the connection does not inherit them. `undefined` when the answer is whole, and always on an engine
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
    : (warnings.find((warning) => capture.tooDeep(warning)) ??
      (await Unlisted(connection, capture.warnings, warnings.length)));
  if (warned) {
    await Clear(connection, capture.warnings.clear);
  }
  return warned;
}

/** The failure of a statement that raised more warnings than the `listed` MariaDB lists for it. */
async function Unlisted(
  connection: PoolConnection,
  warnings: NonNullable<Dialect["capture"]["warnings"]>,
  listed: number,
): Promise<UnlistedWarnings | undefined> {
  if (listed === 0) {
    return undefined;
  }
  const raised = await Raised(connection, warnings);
  return raised > listed ? new UnlistedWarnings(listed, raised) : undefined;
}
