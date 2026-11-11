import type { PoolOptions } from "mysql2/promise";
import { GetRuntimeInfo } from "@antelopejs/interface-core/runtime";

import { type DialectId, IsDialectId } from "./dialect";

/**
 * How aggressively schema registration is allowed to alter existing tables.
 *
 * - `safe`: create missing tables, columns and indexes; refuse changes that could lose data.
 * - `destructive`: additionally allow column type changes and column drops.
 */
export type MigrationMode = "safe" | "destructive";

/**
 * Whose tables an instance serves.
 *
 * - `owned`: the adapter creates and converges the tables it is given, and keeps its own
 *   bookkeeping beside them.
 * - `external`: the tables already exist in a database the adapter does not own. Schema ids name
 *   the server's databases and table and field names are read verbatim; registration reads the
 *   catalog and never runs DDL; rows are read and written, never the structure. `url` is required.
 */
export type Mode = "owned" | "external";

/** Which engine's SQL the instance speaks: detected from the server's version, or named. */
export type DialectSetting = "auto" | DialectId;

/** Whether an external instance answers `@antelopejs/interface-database-catalog`. */
export interface CatalogOptions {
  /**
   * Force the catalog on or off. Unset, it follows the project's development mode: on under
   * `ajs project dev` and `ajs project run`, off under `ajs project start`. The catalog describes
   * and profiles the client's database for a generator, which is development work.
   */
  enabled?: boolean;
}

/**
 * The driver options the module sets itself, because the decoding and the statements depend on
 * them: JSON, dates and big numbers arrive as text, `affectedRows` counts matched rows, one
 * statement per call, prepared statements are bounded per connection, and a released connection
 * keeps its session pin.
 */
export const MODULE_POOL_OPTIONS = {
  charset: "UTF8MB4_GENERAL_CI",
  timezone: "Z",
  jsonStrings: true,
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
  decimalNumbers: false,
  typeCast: true,
  namedPlaceholders: false,
  rowsAsArray: false,
  nestTables: false,
  multipleStatements: false,
  flags: ["FOUND_ROWS"],
  maxPreparedStatements: 128,
  resetOnRelease: false,
} as const satisfies PoolOptions;

/** `pool` options the module owns without listing a value: `url` supplies the URL, the rest stay the driver's. */
const UNSET_MODULE_POOL_OPTIONS = [
  "uri",
  "charsetNumber",
  "queryFormat",
] as const;

/** `pool` options the module owns, which a project's `pool` may not set. */
type ModuleOwnedPoolOption =
  | keyof typeof MODULE_POOL_OPTIONS
  | (typeof UNSET_MODULE_POOL_OPTIONS)[number];

/** `mysql2` pool options a project may set: connection limits, timeouts, TLS. */
export type PoolSettings = Omit<PoolOptions, ModuleOwnedPoolOption>;

const MODULE_OWNED_POOL_OPTIONS: readonly string[] = [
  ...Object.keys(MODULE_POOL_OPTIONS),
  ...UNSET_MODULE_POOL_OPTIONS,
];

/**
 * Module configuration, as accepted by `construct`.
 */
export interface Options {
  /** Whose tables this instance serves. Defaults to `owned`. */
  mode?: Mode;
  /** MySQL connection string, `mysql://user:password@host:port/database`. */
  url?: string;
  /** Additional `mysql2` pool options. The URL wins over a connection setting given in both. */
  pool?: PoolSettings;
  /** Which engine's SQL to speak. Defaults to `auto`, detected from `SELECT VERSION()`. */
  dialect?: DialectSetting;
  /** Prefix applied to every generated table name. */
  schemaPrefix?: string;
  /** Schema convergence policy. Defaults to `safe`. */
  migrations?: MigrationMode;
  /** Rows fetched per round trip when iterating a cursor. Defaults to 100. */
  cursorBatchSize?: number;
  /** How long an untouched cursor is kept open before being reclaimed. Defaults to 60000. */
  cursorIdleTimeoutMs?: number;
  /**
   * Read timeout applied to every pooled connection, as `max_execution_time`, which MySQL applies to
   * `SELECT` statements only. Unset or 0 leaves reads unbounded.
   */
  statementTimeoutMs?: number;
  /**
   * How long a change event stays in the log before it is reaped. Defaults to 300000.
   *
   * This is a contract rather than a tuning parameter: it is the answer to *how long may a
   * consumer stall before its feed is ended*. A feed whose watermark falls below what the reaper
   * has already deleted is ended with an error naming the gap.
   */
  changeRetentionMs?: number;
  /** Change events read from the log per round trip. Defaults to 256. */
  changeBatchSize?: number;
  /**
   * How often a write from another process is looked for while a feed is open. Defaults to 100.
   * A write from this process wakes its feeds directly.
   */
  changePollIntervalMs?: number;
  /** The catalog an external instance answers. See {@link CatalogOptions}. */
  catalog?: CatalogOptions;
}

export interface ResolvedOptions {
  mode: Mode;
  url: string;
  pool: PoolSettings;
  dialect: DialectSetting;
  schemaPrefix: string;
  migrations: MigrationMode;
  cursorBatchSize: number;
  cursorIdleTimeoutMs: number;
  statementTimeoutMs?: number;
  changeRetentionMs: number;
  changeBatchSize: number;
  changePollIntervalMs: number;
  catalog: CatalogOptions;
}

const DEFAULT_URL = "mysql://root@localhost:3306/antelopejs";
const DEFAULT_MODE: Mode = "owned";
const MODES: readonly Mode[] = ["owned", "external"];
const AUTO_DIALECT = "auto";

/**
 * The options that configure what only an owned instance does: its own table names, its DDL, and
 * its change log. An external instance refuses them by name rather than ignoring them, since an
 * option accepted and never applied reads as one that took effect.
 */
const OWNED_ONLY_OPTIONS: readonly (keyof Options)[] = [
  "schemaPrefix",
  "migrations",
  "changeRetentionMs",
  "changeBatchSize",
  "changePollIntervalMs",
];
const DEFAULT_MIGRATIONS: MigrationMode = "safe";
const DEFAULT_SCHEMA_PREFIX = "";
const DEFAULT_CURSOR_BATCH_SIZE = 100;
const DEFAULT_CURSOR_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_CHANGE_RETENTION_MS = 300_000;
const DEFAULT_CHANGE_BATCH_SIZE = 256;
const DEFAULT_CHANGE_POLL_INTERVAL_MS = 100;

const SMALLEST_POSITIVE_INTEGER = 1;
const SMALLEST_TIMEOUT = 0;

const NOT_CONFIGURED =
  "MySQL adapter is not configured: construct() has not run yet";

let resolved: ResolvedOptions | undefined;

/**
 * A supplied option read as a safe integer no smaller than `minimum`, refused otherwise.
 *
 * Several of these reach statement text as literals, and the configuration is untyped where it
 * arrives, so an unvalidated value would be arbitrary SQL coming through the configuration surface.
 */
function SafeInteger(
  option: string,
  supplied: number | undefined,
  fallback: number,
  minimum = SMALLEST_POSITIVE_INTEGER,
): number {
  if (supplied === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(supplied) || supplied < minimum) {
    const kind = minimum === SMALLEST_TIMEOUT ? "non-negative" : "positive";
    throw new Error(
      `${option} must be a ${kind} safe integer, received ${String(supplied)}`,
    );
  }
  return supplied;
}

function ResolveMode(options?: Options): Mode {
  const mode = options?.mode ?? DEFAULT_MODE;
  if (!MODES.includes(mode)) {
    throw new Error(
      `mode must be one of ${MODES.join(", ")}, received ${String(mode)}`,
    );
  }
  if (mode === "external") {
    const refused = OWNED_ONLY_OPTIONS.filter(
      (option) => options?.[option] !== undefined,
    );
    if (refused.length > 0) {
      throw new Error(
        `${refused.join(", ")} cannot be set with mode "external": an external instance owns no tables, runs no DDL and keeps no change log`,
      );
    }
  }
  return mode;
}

function ResolveUrl(mode: Mode, options?: Options): string {
  if (options?.url !== undefined && options.url.trim() !== "") {
    return options.url;
  }
  if (mode === "external") {
    throw new Error(
      `mode "external" needs a non-empty config.url; set it through the project's envOverrides`,
    );
  }
  return DEFAULT_URL;
}

function ResolveDialect(supplied?: DialectSetting): DialectSetting {
  if (supplied === undefined || supplied === AUTO_DIALECT) {
    return AUTO_DIALECT;
  }
  if (!IsDialectId(supplied)) {
    throw new Error(
      `dialect must be "${AUTO_DIALECT}" or a supported engine, received ${String(supplied)}`,
    );
  }
  return supplied;
}

/** Refuses a `pool` option the module sets itself, naming it, rather than letting it change what decoding expects. */
function ResolvePool(pool: PoolSettings = {}): PoolSettings {
  const owned = MODULE_OWNED_POOL_OPTIONS.filter((option) =>
    Object.hasOwn(pool, option),
  );
  if (owned.length > 0) {
    throw new Error(
      `pool.${owned.join(", pool.")} cannot be set: the module sets ${owned.length === 1 ? "it" : "them"} itself`,
    );
  }
  return pool;
}

export function SetOptions(options?: Options): ResolvedOptions {
  const mode = ResolveMode(options);
  const url = ResolveUrl(mode, options);
  resolved = {
    mode,
    url,
    pool: ResolvePool(options?.pool),
    dialect: ResolveDialect(options?.dialect),
    schemaPrefix: options?.schemaPrefix ?? DEFAULT_SCHEMA_PREFIX,
    migrations: options?.migrations ?? DEFAULT_MIGRATIONS,
    cursorBatchSize: SafeInteger(
      "cursorBatchSize",
      options?.cursorBatchSize,
      DEFAULT_CURSOR_BATCH_SIZE,
    ),
    cursorIdleTimeoutMs: SafeInteger(
      "cursorIdleTimeoutMs",
      options?.cursorIdleTimeoutMs,
      DEFAULT_CURSOR_IDLE_TIMEOUT_MS,
    ),
    statementTimeoutMs:
      options?.statementTimeoutMs === undefined
        ? undefined
        : SafeInteger(
            "statementTimeoutMs",
            options.statementTimeoutMs,
            SMALLEST_TIMEOUT,
            SMALLEST_TIMEOUT,
          ),
    changeRetentionMs: SafeInteger(
      "changeRetentionMs",
      options?.changeRetentionMs,
      DEFAULT_CHANGE_RETENTION_MS,
    ),
    changeBatchSize: SafeInteger(
      "changeBatchSize",
      options?.changeBatchSize,
      DEFAULT_CHANGE_BATCH_SIZE,
    ),
    changePollIntervalMs: SafeInteger(
      "changePollIntervalMs",
      options?.changePollIntervalMs,
      DEFAULT_CHANGE_POLL_INTERVAL_MS,
    ),
    catalog: options?.catalog ?? {},
  };
  return resolved;
}

export function GetOptions(): ResolvedOptions {
  if (!resolved) {
    throw new Error(NOT_CONFIGURED);
  }
  return resolved;
}

/** Whether the configured instance serves tables it does not own. */
export function IsExternal(): boolean {
  return GetOptions().mode === "external";
}

/** Whether the catalog answers: `catalog.enabled` when set, and otherwise the project's development mode. */
export async function IsCatalogEnabled(): Promise<boolean> {
  const configured = GetOptions().catalog.enabled;
  return configured ?? (await GetRuntimeInfo()).dev;
}

export function ClearOptions() {
  resolved = undefined;
}
