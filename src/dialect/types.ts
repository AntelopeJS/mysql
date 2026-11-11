import type { Sql } from "../statement";
import type { SqlType } from "../implementations/database/types";
import type { CompilerSyntax } from "./sql-types";
import type { ErrorSyntax } from "./error-types";
import type { CatalogSyntax, DdlSyntax } from "./ddl";

/**
 * The only thing the compiler, the planners and the runtimes know about an engine.
 *
 * Every member is a pure function from values to {@link Sql} or a constant, with no I/O, so a
 * dialect is tested without a server. Algorithms that are the same on every engine stay in the
 * shared code; a member exists only where the engine's SQL differs, and its name says what it
 * means, not how it is spelled. Later units add the JSON, DDL, catalog, capture and error members
 * beside the code that calls them.
 */
export interface Dialect {
  readonly id: string;
  readonly session: SessionSyntax;
  readonly sql: SqlSyntax;
  readonly errors: ErrorSyntax;
  readonly ddl: DdlSyntax;
  readonly catalog: CatalogSyntax;
}

/** The module options a session pin depends on. */
export interface SessionSettings {
  /** Becomes the session's read timeout; unset leaves the server's. */
  readonly statementTimeoutMs?: number;
}

/** What every connection runs before its first use, the limits that shape plans, and the engine's named locks. */
export interface SessionSyntax {
  /**
   * The one statement that pins a new connection: UTC, utf8mb4 with the binary NO PAD collation,
   * strict mode without `NO_BACKSLASH_ESCAPES`, `PIPES_AS_CONCAT` or `ANSI_QUOTES`, English server
   * messages, and a group concatenation limit no aggregate reaches.
   */
  pin(settings: SessionSettings): Sql;
  /** Sets the session's read timeout to `ms`, where 0 leaves reads unbounded. */
  statementTimeout(ms: number): Sql;
  /** The binary, NO PAD collation of every text column, literal and bound parameter. */
  readonly binaryCollation: string;
  /** The most bytes an index key may span, `_instance` included. */
  readonly keyBudgetBytes: number;
  /** Whether a `multi` index over a JSON array can be built as a multi-valued index. */
  readonly multiValuedIndex: boolean;
  /** A lock name for a purpose and a scope, within the engine's name limit whatever the scope. */
  lockName(purpose: string, scope: string): string;
  /** Takes a named session lock, waiting at most `waitSeconds`; answers one row with `acquired` 1 or 0. */
  acquireLock(name: string, waitSeconds: number): Sql;
  /** Releases a named session lock this session holds. */
  releaseLock(name: string): Sql;
}

/** Expression fragments. The compiler never spells an engine type or a quoting rule itself. */
export interface SqlSyntax extends CompilerSyntax {
  quote(identifier: string): Sql;
  /** The column type a value of this type is stored in. */
  physical(type: SqlType): Sql;
}
