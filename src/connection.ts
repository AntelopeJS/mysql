import type { EventEmitter } from "node:events";
import {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
  createPool,
} from "mysql2/promise";

import { Logger } from "./logger";
import { Bind, type Sql, sql } from "./statement";
import { DIALECTS, type Dialect, DetectDialect } from "./dialect";
import { DescribeConnectFailure } from "./connect-failure";
import {
  ClearOptions,
  type DialectSetting,
  GetOptions,
  IsCatalogEnabled,
  IsExternal,
  MODULE_POOL_OPTIONS,
  type Options,
  SetOptions,
} from "./config";

const NOT_CONNECTED = "MySQL adapter is not connected";

const NOT_CONSTRUCTED = "construct() has not run yet";

const CONNECTION_ERROR = "error";

const CONNECTION_FAILED = "a pooled MySQL connection failed";

const CONNECTED = "connected to";

const DISCONNECTED = "disconnected from";

const STARTED_UNCONNECTED =
  "could not connect to MySQL; the instance starts without a connection and refuses every call until the project reloads";

const SLOW_ACQUIRE_MS = 10_000;

/**
 * Says what a caller that is merely blocked cannot say for itself, since the wait has no deadline.
 *
 * `mysql2` queues an acquisition once the pool is full and otherwise opens a new connection, so this
 * one wait covers both a pool held by cursors still being iterated and a server that is not
 * answering; nothing here can tell those apart, so it names the symptom only.
 */
const SLOW_ACQUIRE = `no MySQL connection has become available in ${SLOW_ACQUIRE_MS} ms: either every pooled connection is checked out (a cursor holds one for as long as it is iterated) or a new connection is not being answered. Raise pool.connectionLimit, or set pool.waitForConnections to false to fail rather than wait`;

const VERSION_QUERY = sql`SELECT VERSION() AS version`;

/** A value a result column arrives as, given {@link MODULE_POOL_OPTIONS}: JSON, dates and big numbers as text. */
type Cell = string | number | null | Buffer;

/** One result row, keyed by column alias. */
export type Row = ReadonlyMap<string, Cell>;

let pool: Pool | undefined;
let generation = 0;
let dialect: Dialect | undefined;
let connectFailure: string | undefined;
let isWaiting = false;

/** Connections, by their driver object, that have run the session pin. */
const pinned = new WeakSet<object>();

export type BeforeDisconnect = () => void | PromiseLike<void>;

export type PoolTeardown = () => Promise<void>;

const beforeDisconnect = new Set<BeforeDisconnect>();

/** Turns a callback's synchronous throw into a rejection, which is all `allSettled` can absorb. */
async function Invoke(callback: BeforeDisconnect) {
  return callback();
}

function ReportConnectionError(err: Error) {
  Logger.Warn(CONNECTION_FAILED, err);
}

/**
 * Gives a pooled connection, for its whole life, an `error` listener of its own.
 *
 * `mysql2` attaches a `once("error")` listener that removes a connection from the pool, and emits
 * `error` on a pooled connection for every fatal failure, a dropped socket, a server restart or a
 * `KILL` among them, whether or not a statement was running. Once that listener has fired, a second
 * `error`, such as a write attempted on the closed socket, has no listener, and an `error` event with
 * no listener is an uncaught exception that ends the host process.
 *
 * Logging is the whole handling: the pool discards the broken connection itself, and a statement
 * that was running on it rejects through its own callback. The listener is attached once, when the
 * pool creates the connection, and stays for the connection's life, so it never accumulates.
 */
export function GuardConnection<T extends EventEmitter>(connection: T): T {
  connection.on(CONNECTION_ERROR, ReportConnectionError);
  return connection;
}

/**
 * Whether a failed first connection is kept as the instance's state rather than failing construct:
 * an external instance whose catalog answers, which is development work on someone else's database.
 */
async function ToleratesConnectFailure(): Promise<boolean> {
  return IsExternal() && (await IsCatalogEnabled());
}

function IsCell(value: unknown): value is Cell {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    Buffer.isBuffer(value)
  );
}

/** Reads the cells of one driver row into a {@link Row}, refusing a value the module's driver options never produce. */
export function ParseRow(cells: Iterable<readonly [string, unknown]>): Row {
  const parsed = new Map<string, Cell>();
  for (const [column, value] of cells) {
    if (!IsCell(value)) {
      throw new Error(
        `Column '${column}' arrived as ${Object.prototype.toString.call(value)}, which the module's driver options never produce`,
      );
    }
    parsed.set(column, value);
  }
  return parsed;
}

/**
 * A statement as it runs under the connected dialect's read timeout. Without `statementTimeoutMs`
 * no statement is bounded, and every statement goes as it was written.
 */
export function Uncapped(statement: Sql): Sql {
  if (!dialect || !GetOptions().statementTimeoutMs) {
    return statement;
  }
  return dialect.session.uncapped(statement);
}

async function ReadOn(
  connection: PoolConnection,
  statement: Sql,
): Promise<Row[]> {
  const bound = Bind(Uncapped(statement));
  const [rows] = await connection.execute<RowDataPacket[]>(bound.sql, [
    ...bound.args,
  ]);
  return rows.map((row) => ParseRow(Object.entries(row)));
}

async function DetectedDialect(
  connection: PoolConnection,
  setting: DialectSetting,
): Promise<Dialect> {
  if (setting !== "auto") {
    return DIALECTS[setting];
  }
  const [row] = await ReadOn(connection, VERSION_QUERY);
  return DIALECTS[DetectDialect(String(row.get("version")))];
}

/** Runs the dialect's session pin on a connection that has not run it yet. */
async function Pin(connection: PoolConnection, engine: Dialect) {
  if (pinned.has(connection.connection)) {
    return;
  }
  const settings = { statementTimeoutMs: GetOptions().statementTimeoutMs };
  await connection.query(Bind(engine.session.pin(settings)).sql);
  pinned.add(connection.connection);
}

/**
 * Takes a connection out of the pool, pinned. A connection whose pin fails is destroyed rather
 * than handed out, so no statement ever runs on an unpinned session.
 */
async function Checkout(
  current: Pool,
  engine: Dialect,
): Promise<PoolConnection> {
  const connection = await current.getConnection();
  try {
    await Pin(connection, engine);
  } catch (err) {
    connection.destroy();
    throw err;
  }
  return connection;
}

/** Opens the first connection, settles the dialect and pins the connection with it. */
async function Verify(
  created: Pool,
  setting: DialectSetting,
): Promise<Dialect> {
  const connection = await created.getConnection();
  try {
    const engine = await DetectedDialect(connection, setting);
    await Pin(connection, engine);
    connection.release();
    return engine;
  } catch (err) {
    connection.destroy();
    throw err;
  }
}

/**
 * Opens the connection pool, settles the dialect and verifies the server is reachable.
 *
 * Called before any interface is implemented so no query can observe a half-initialized pool.
 *
 * Every connection runs the dialect's session pin before its first statement: UTC, the binary
 * NO PAD collation for literals and bound parameters, strict mode and English messages. The pin
 * runs when a connection is first checked out, and a connection whose pin fails is destroyed, so
 * a failure fails the acquisition rather than leaving an unpinned session in the pool. The dialect
 * comes from `SELECT VERSION()` on the first connection unless `dialect` names one.
 *
 * A failed verification fails construct, except on an external instance whose catalog answers:
 * there the pool is ended, the options are kept, and the failure, worded for a person, becomes the
 * reason every later call is refused. Nothing retries; the project's next reload constructs again.
 */
export async function Connect(options?: Options) {
  await Disconnect();
  const resolved = SetOptions(options);
  const created = createPool({
    ...resolved.pool,
    uri: resolved.url,
    ...MODULE_POOL_OPTIONS,
    flags: [...MODULE_POOL_OPTIONS.flags],
  });
  created.on("connection", GuardConnection);
  let engine: Dialect;
  try {
    engine = await Verify(created, resolved.dialect);
  } catch (err) {
    await created.end();
    if (err instanceof Error && (await ToleratesConnectFailure())) {
      connectFailure = DescribeConnectFailure(err, resolved.url);
      Logger.Warn(STARTED_UNCONNECTED, connectFailure);
      return;
    }
    ClearOptions();
    throw err;
  }
  generation += 1;
  dialect = engine;
  pool = created;
  Logger.Info(`${CONNECTED} ${engine.name}`);
}

/**
 * Registers a callback to be settled before the pool is ended, and answers a function that
 * withdraws it again.
 *
 * Anything holding a connection past a single statement, which is what a cursor's stream or a
 * named lock does, has to give it back before the pool closes: `pool.end()` queues its quit behind
 * whatever the connection is still running. The holders sit below this module and import from it,
 * so the dependency is inverted through this registry rather than spelled as an import back.
 *
 * A registration outlives a `Connect`/`Disconnect` cycle: a module that registers at load time is
 * still registered after a reconnect.
 */
export function RegisterBeforeDisconnect(callback: BeforeDisconnect) {
  beforeDisconnect.add(callback);
  return () => {
    beforeDisconnect.delete(callback);
  };
}

/**
 * Settles every registered callback, then runs `endPool`.
 *
 * A callback that throws or rejects must not keep the pool open, so the outcomes are settled and
 * discarded rather than raced. `Disconnect` is its only production caller; it is a seam because a
 * spec cannot drive `Disconnect` without replacing the pool a live adapter in the same process is
 * querying through.
 */
export async function SettleBeforeDisconnect(endPool: PoolTeardown) {
  await Promise.allSettled([...beforeDisconnect].map(Invoke));
  await endPool();
}

async function EndPool() {
  const current = pool;
  const engine = dialect;
  pool = undefined;
  dialect = undefined;
  connectFailure = undefined;
  ClearOptions();
  if (current) {
    await current.end();
    Logger.Info(`${DISCONNECTED} ${engine?.name}`);
  }
}

/** Settles every `RegisterBeforeDisconnect` callback, then ends the pool and forgets the options. */
export async function Disconnect() {
  await SettleBeforeDisconnect(EndPool);
}

function NotConnected(): Error {
  return new Error(`${NOT_CONNECTED}: ${connectFailure ?? NOT_CONSTRUCTED}`);
}

function GetPool(): Pool {
  if (!pool) {
    throw NotConnected();
  }
  return pool;
}

/** Refuses with why there is no connection, when there is none; an external catalog's guard. */
export function AssertConnected(): void {
  GetPool();
}

/**
 * Which pool is open: a number every `Connect` that opens one raises, so work started on an earlier
 * pool can tell it ran on one that has since ended. None while no pool is open.
 */
export function PoolGeneration(): number | undefined {
  return pool ? generation : undefined;
}

/** The dialect of the connected server, or a refusal with why there is none. */
export function GetDialect(): Dialect {
  if (!dialect) {
    throw NotConnected();
  }
  return dialect;
}

/** Warns once per episode of waiting, however many callers are queued behind the same one. */
function WarnSlowAcquire() {
  if (isWaiting) {
    return;
  }
  isWaiting = true;
  Logger.Warn(SLOW_ACQUIRE);
}

/**
 * Takes a pinned connection out of the pool for the caller to own; the caller releases it.
 *
 * For a session that outlives one statement: a cursor's stream, a named lock, a transaction. The
 * wait for a connection has no deadline, which is legitimate while cursors hold the pool, but a
 * caller blocked inside it can say nothing about why, which is what {@link SLOW_ACQUIRE} is for. One
 * line per episode, not per caller; the timer is `unref`'d and cleared however the wait settles.
 */
export function AcquireConnection(): Promise<PoolConnection> {
  const current = GetPool();
  const engine = GetDialect();
  const slow = setTimeout(WarnSlowAcquire, SLOW_ACQUIRE_MS);
  slow.unref();
  return Checkout(current, engine).finally(() => {
    clearTimeout(slow);
    isWaiting = false;
  });
}

/**
 * Takes a pinned connection for one statement that streams for as long as its reader takes, free
 * of `statementTimeoutMs`: the server counts a streaming `SELECT` as executing until its last row
 * is read, so the cap would end a cursor whose reader is merely slow. Give it back through
 * {@link ReleaseCapped}.
 */
export async function AcquireUncapped(): Promise<PoolConnection> {
  const connection = await AcquireConnection();
  if (!GetOptions().statementTimeoutMs) {
    return connection;
  }
  try {
    await connection.query(Bind(GetDialect().session.statementTimeout(0)).sql);
  } catch (err) {
    connection.destroy();
    throw err;
  }
  return connection;
}

/**
 * Gives back a connection of {@link AcquireUncapped} with the cap restored, so the next statement
 * on it is bounded as every pooled one is. A connection whose cap cannot be restored is destroyed
 * rather than pooled unbounded.
 */
export async function ReleaseCapped(connection: PoolConnection): Promise<void> {
  try {
    const cap = GetOptions().statementTimeoutMs;
    if (cap) {
      await connection.query(
        Bind(GetDialect().session.statementTimeout(cap)).sql,
      );
    }
  } catch {
    connection.destroy();
    return;
  }
  connection.release();
}

/**
 * Runs a statement through the prepared-statement protocol and answers its rows.
 *
 * On `held` when given, which stays checked out; otherwise on a pooled connection taken for this
 * statement alone.
 */
export async function Read(
  statement: Sql,
  held?: PoolConnection,
): Promise<Row[]> {
  if (held) {
    return ReadOn(held, statement);
  }
  const connection = await AcquireConnection();
  try {
    return await ReadOn(connection, statement);
  } finally {
    connection.release();
  }
}

async function WriteOn(
  connection: PoolConnection,
  statement: Sql,
): Promise<number> {
  const bound = Bind(Uncapped(statement));
  const [result] = await connection.execute<ResultSetHeader>(bound.sql, [
    ...bound.args,
  ]);
  return result.affectedRows;
}

/**
 * Runs a statement that writes through the prepared-statement protocol and answers the rows it
 * matched: the pool connects with `FOUND_ROWS`, so a row a write matched and left unchanged counts.
 *
 * On `held` when given, which stays checked out; otherwise on a pooled connection taken for this
 * statement alone.
 */
export async function Write(
  statement: Sql,
  held?: PoolConnection,
): Promise<number> {
  if (held) {
    return WriteOn(held, statement);
  }
  const connection = await AcquireConnection();
  try {
    return await WriteOn(connection, statement);
  } finally {
    connection.release();
  }
}

export function GetSchemaPrefix() {
  return GetOptions().schemaPrefix;
}
