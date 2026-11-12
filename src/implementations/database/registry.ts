import { randomUUID } from "node:crypto";

import type { Sql } from "../../statement";
import type { ChangeLogTables, Dialect, InstancesTable } from "../../dialect";
import { GetSchemaPrefix } from "../../connection";
import { MysqlIdentifier } from "./identifier";

/**
 * The table every schema's named instances are recorded in. It is shared by every schema and
 * every prefix in the database, so rows are keyed by {@link SchemaKey}.
 */
export const INSTANCES: InstancesTable = {
  table: "__antelope_instances",
  schema: "schema_id",
  instance: "instance_id",
  created: "created_at",
};

/**
 * The change log every watched table's triggers write to, shared by every schema and prefix in the
 * database: a log row names its physical table.
 */
export const CHANGE_LOG: ChangeLogTables = {
  log: "__antelope_changes",
  clock: "__antelope_change_clock",
  reaped: "__antelope_change_reaped",
  oldImage: "old_row",
  newImage: "new_row",
};

/**
 * Everything the module keeps beside the tables it owns, each statement creating its object only
 * when absent. Every tables phase runs them before it converges a table.
 */
export function RegistryStatements(dialect: Dialect): readonly Sql[] {
  return [
    dialect.ddl.createInstances(INSTANCES),
    ...dialect.capture.bootstrap(CHANGE_LOG, randomUUID()),
  ];
}

/**
 * How the registry and the convergence locks name a schema: the table prefix and the schema id,
 * fitted to an identifier, so two deployments with different prefixes never share an entry.
 */
export function SchemaKey(schemaId: string): string {
  return MysqlIdentifier(`${GetSchemaPrefix()}${schemaId}`);
}
