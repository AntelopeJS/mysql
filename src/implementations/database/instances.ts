import type { QueryStage } from "@antelopejs/interface-database/common";

import { ident, param, sql } from "../../statement";
import { GetSchemaPrefix, Read } from "../../connection";
import { TableName } from "./identifier";
import { OnDedicatedSession } from "./locks";
import { INSTANCES, SchemaKey } from "./registry";
import {
  DEFAULT_INSTANCE_ID,
  INSTANCE_COLUMN,
  NormalizeInstanceId,
} from "./utils";

const REGISTRY = ident(INSTANCES.table);
const SCHEMA_KEY = ident(INSTANCES.schema);
const INSTANCE_KEY = ident(INSTANCES.instance);

/**
 * Records an instance of a schema and answers the id it was recorded under.
 *
 * Idempotent: creating an instance that already exists is a no-op rather than a conflict, because
 * the contract gives callers no way to ask whether one is already there and they routinely create
 * the same instance on every boot.
 */
export async function CreateInstance(
  schemaId: string,
  stage: QueryStage,
): Promise<string> {
  const instanceId = NormalizeInstanceId("createInstance", stage);
  await OnDedicatedSession((session) =>
    session.write(
      sql`INSERT INTO ${REGISTRY} (${SCHEMA_KEY}, ${INSTANCE_KEY}) VALUES (${param(SchemaKey(schemaId))}, ${param(instanceId)}) ON DUPLICATE KEY UPDATE ${INSTANCE_KEY} = ${INSTANCE_KEY}`,
    ),
  );
  return instanceId;
}

/**
 * Deletes an instance's rows from each of the schema's tables, then forgets it, in one transaction.
 *
 * An instance is a discriminator column rather than a namespace, so nothing here drops a table: the
 * same tables still hold every other instance's rows. A failure part way ends the session, which
 * rolls the transaction back, so no rows are left behind for a later `createInstance` of the same id
 * to adopt.
 *
 * @param tableIds The schema's table ids, as the registered declaration names them.
 */
export async function DestroyInstance(
  schemaId: string,
  tableIds: readonly string[],
  stage: QueryStage,
): Promise<void> {
  const instanceId = param(NormalizeInstanceId("destroyInstance", stage));
  const prefix = GetSchemaPrefix();
  await OnDedicatedSession(async (session) => {
    await session.apply(sql`START TRANSACTION`);
    for (const tableId of tableIds) {
      const table = ident(TableName(prefix, schemaId, tableId));
      await session.write(
        sql`DELETE FROM ${table} WHERE ${ident(INSTANCE_COLUMN)} = ${instanceId}`,
      );
    }
    await session.write(
      sql`DELETE FROM ${REGISTRY} WHERE ${SCHEMA_KEY} = ${param(SchemaKey(schemaId))} AND ${INSTANCE_KEY} = ${instanceId}`,
    );
    await session.apply(sql`COMMIT`);
  });
}

/** Lists the schema's named instances; the default instance is not one. */
export async function ListInstances(schemaId: string): Promise<string[]> {
  const rows = await Read(
    sql`SELECT ${INSTANCE_KEY} AS id FROM ${REGISTRY} WHERE ${SCHEMA_KEY} = ${param(SchemaKey(schemaId))} AND ${INSTANCE_KEY} <> ${param(DEFAULT_INSTANCE_ID)} ORDER BY ${INSTANCE_KEY}`,
  );
  return rows.map((row) => String(row.get("id")));
}
