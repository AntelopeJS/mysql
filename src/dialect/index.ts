import { mysql } from "./mysql";

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
 * compiler, planner or runtime file names an engine.
 */
export const DIALECTS = { mysql } as const;

export type DialectId = keyof typeof DIALECTS;

const MARIADB_MARKER = /mariadb/i;

/** Whether a name is one of {@link DIALECTS}. */
export function IsDialectId(id: string): id is DialectId {
  return Object.hasOwn(DIALECTS, id);
}

/**
 * The dialect for a server, from `SELECT VERSION()`: a version naming MariaDB is MariaDB, anything
 * else is MySQL. An engine with no entry in {@link DIALECTS} is refused by name.
 */
export function DetectDialect(version: string): DialectId {
  const engine = MARIADB_MARKER.test(version) ? "mariadb" : "mysql";
  if (!IsDialectId(engine)) {
    throw new Error(
      `The server reports version '${version}', which is ${engine}; this module does not support ${engine} yet`,
    );
  }
  return engine;
}
