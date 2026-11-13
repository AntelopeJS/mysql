import { mysql } from "./mysql";
import { mariadb } from "./mariadb";

export type { Dialect, SessionSyntax } from "./types";
export type {
  DdlFailure,
  DdlSyntax,
  InstancesTable,
  ObservedColumn,
  ObservedIndex,
  ObservedTable,
  RowKey,
} from "./ddl";
export type {
  CapturedColumn,
  ChangeLogTables,
  ChangeOperation,
} from "./capture";

/**
 * The one list of engines. A new engine is one entry here and one directory beside `mysql/`; no
 * compiler, planner or runtime file names an engine. MariaDB is MySQL's family, so its directory
 * holds only what it spells its own way.
 */
export const DIALECTS = { mysql, mariadb } as const;

export type DialectId = keyof typeof DIALECTS;

/** Every engine's name, for a message about a server no configuration or answer has identified. */
export const ANY_ENGINE = Object.values(DIALECTS)
  .map(({ name }) => name)
  .join(" or ");

const MARIADB_MARKER = /mariadb/i;

/** Whether a name is one of {@link DIALECTS}. */
export function IsDialectId(id: string): id is DialectId {
  return Object.hasOwn(DIALECTS, id);
}

/**
 * The dialect for a server, from `SELECT VERSION()`: a version naming MariaDB is MariaDB, anything
 * else is MySQL.
 */
export function DetectDialect(version: string): DialectId {
  return MARIADB_MARKER.test(version) ? "mariadb" : "mysql";
}
