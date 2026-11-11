import assert from "node:assert";
import type {
  IndexDefinition,
  SchemaDefinition,
  TableDefinition,
} from "@antelopejs/interface-database/schema";

import { Logger } from "../../logger";
import { GetOptions, IsExternal } from "../../config";
import { GetDialect, GetSchemaPrefix } from "../../connection";
import { BuildIndexes } from "./migrate-indexes";
import { ConvergeTables } from "./migrate-tables";
import { ParseSchema, type SchemaModel, type TableModel } from "./fields";
import { DescribeExternalSchema } from "./external-schema";
import {
  BuildSchemaPlan,
  type IndexRefusal,
  ServesCrossInstance,
  type TablePlan,
} from "./plan";

/** Told the name a `CROSS_INSTANCE` read scans a table by. */
export type CrossInstanceScanNotice = (indexId: string) => void;

type TableScanNotices = Record<string, CrossInstanceScanNotice>;

const definitions = new Map<string, SchemaDefinition>();
const schemaModels = new Map<string, SchemaModel>();
const schemaPlans = new Map<string, ReadonlyMap<string, TablePlan>>();
const scanNotices = new Map<string, TableScanNotices>();
const ready = new Map<string, Promise<void>>();
const indexing = new Map<string, Promise<void>>();
const guardedWrites = new Set<string>();

function UnservedScanWarning(
  schemaId: string,
  tableId: string,
  indexId: string,
): string {
  return `A CROSS_INSTANCE query on '${schemaId}.${tableId}' scans index '${indexId}', which is not declared crossInstance: its physical index leads with the instance, so the query stays correct but may be slow. Set crossInstance: true on the index to keep such queries fast`;
}

function RefusedIndexWarning(schemaId: string, refusal: IndexRefusal): string {
  return `Index '${refusal.index}' on '${schemaId}.${refusal.table}' is not built: ${refusal.reason}. Queries stay correct without it`;
}

/** The declared indexes of a table no unprefixed physical index backs. */
function UnservedIndexes(table: TableDefinition): Set<string> {
  const indexes = Object.entries(table.indexes ?? {});
  const unserved = indexes.filter(([, index]) => !ServesCrossInstance(index));
  return new Set(unserved.map(([indexId]) => indexId));
}

/**
 * Warns, once per index per registration, that a `CROSS_INSTANCE` read scans a declared index no
 * unprefixed physical index backs. The set is computed once, so the read pays one lookup; a name
 * that is not a declared index is a plain field, and never warns.
 */
function ScanNotice(
  schemaId: string,
  tableId: string,
  unserved: Set<string>,
): CrossInstanceScanNotice {
  return (indexId) => {
    if (unserved.delete(indexId)) {
      Logger.Warn(UnservedScanWarning(schemaId, tableId, indexId));
    }
  };
}

function SchemaScanNotices(schemaId: string, schema: SchemaDefinition) {
  const notices: TableScanNotices = {};
  for (const [tableId, table] of Object.entries(schema)) {
    notices[tableId] = ScanNotice(schemaId, tableId, UnservedIndexes(table));
  }
  return notices;
}

/** An external table has no instances to scan across, so nothing ever warns about one. */
const NO_SCAN_NOTICE: CrossInstanceScanNotice = () => undefined;

/**
 * An external relation's plan: its name as the declaration spells it, and no column, key column or
 * index the adapter would create, since it creates none.
 */
function ExternalPlan(schemaId: string, tableId: string): TablePlan {
  return {
    schemaId,
    tableId,
    table: tableId,
    columns: [],
    keyColumns: [],
    indexes: [],
  };
}

/** Reads each declared relation from the client's catalog once, and records what it read. */
async function InitializeExternal(
  schemaId: string,
  schema: SchemaDefinition,
  model: SchemaModel,
) {
  const described = await DescribeExternalSchema(
    GetDialect(),
    schemaId,
    schema,
    model,
  );
  const tableIds = Object.keys(described);
  schemaModels.set(schemaId, described);
  schemaPlans.set(
    schemaId,
    new Map(
      tableIds.map((tableId) => [tableId, ExternalPlan(schemaId, tableId)]),
    ),
  );
  scanNotices.set(
    schemaId,
    Object.fromEntries(tableIds.map((tableId) => [tableId, NO_SCAN_NOTICE])),
  );
}

/**
 * Parses the schema, plans its tables and converges them; the secondary indexes then converge in
 * the background, tracked in `indexing`, so the readiness gate never waits on an index build. An
 * index the engine cannot build is reported once and left out; every other refusal fails the
 * registration with its reason.
 */
async function initialize(schemaId: string, schema: SchemaDefinition) {
  const model = ParseSchema(schemaId, schema);
  if (IsExternal()) {
    await InitializeExternal(schemaId, schema, model);
    return;
  }
  const planned = BuildSchemaPlan(schemaId, schema, model, {
    prefix: GetSchemaPrefix(),
    session: GetDialect().session,
  });
  for (const refusal of planned.refusals) {
    Logger.Warn(RefusedIndexWarning(schemaId, refusal));
  }
  schemaModels.set(schemaId, model);
  schemaPlans.set(
    schemaId,
    new Map(planned.tables.map((plan) => [plan.tableId, plan])),
  );
  scanNotices.set(schemaId, SchemaScanNotices(schemaId, schema));
  await ConvergeTables(schemaId, planned.tables, GetOptions().migrations);
  const earlier = indexing.get(schemaId);
  const phase = BuildIndexes(schemaId, planned.tables);
  indexing.set(
    schemaId,
    earlier ? Promise.all([earlier, phase]).then(() => undefined) : phase,
  );
  guardedWrites.delete(schemaId);
  if (
    planned.tables.some((plan) => plan.indexes.some((index) => index.unique))
  ) {
    guardedWrites.add(schemaId);
  }
}

/**
 * Implementation of the `Schemas` registering proxy.
 *
 * Registration is driven by a consumer's module import side effect and is not
 * awaited by the caller, so the resulting promise is tracked here and awaited by
 * the query path through {@link WaitForSchemaReady}. A failed registration keeps
 * its rejected promise so the gate rethrows that failure rather than letting the
 * query path proceed against a schema that was never parsed.
 *
 * The definition is parsed before the database is touched, so a declaration the
 * parser rejects fails with its message without opening a connection.
 *
 * **A failed registration only rolls back state it still owns.** Registration is fire-and-forget
 * and re-registering an id is legal, so a slow failure can settle *after* a later registration of
 * the same id has already succeeded and installed its own definition, shape and gate; deleting
 * unconditionally there would wipe the live schema.
 */
export const Schemas = {
  register(schemaId: string, schema: SchemaDefinition) {
    definitions.set(schemaId, schema);
    const pending: Promise<void> = initialize(schemaId, schema).catch(
      (err: unknown) => {
        if (ready.get(schemaId) === pending) {
          definitions.delete(schemaId);
          schemaModels.delete(schemaId);
          schemaPlans.delete(schemaId);
          scanNotices.delete(schemaId);
          guardedWrites.delete(schemaId);
        }
        throw err;
      },
    );
    ready.set(schemaId, pending);
    pending.catch(() => {});
    return pending;
  },
  unregister(schemaId: string) {
    definitions.delete(schemaId);
    schemaModels.delete(schemaId);
    schemaPlans.delete(schemaId);
    scanNotices.delete(schemaId);
    ready.delete(schemaId);
    indexing.delete(schemaId);
    guardedWrites.delete(schemaId);
  },
};

function MissingSchema(schemaId: string): string {
  return `Unknown schema '${schemaId}'`;
}

function MissingTable(schemaId: string, tableId: string): string {
  return `Unknown table '${schemaId}.${tableId}'`;
}

export function WaitForSchemaReady(schemaId: string): Promise<void> {
  return ready.get(schemaId) ?? Promise.resolve();
}

export function GetSchema(schemaId: string): SchemaDefinition {
  const schema = definitions.get(schemaId);
  assert(schema, MissingSchema(schemaId));
  return schema;
}

export function GetTable(schemaId: string, tableId: string): TableDefinition {
  const schema = GetSchema(schemaId);
  assert(Object.hasOwn(schema, tableId), MissingTable(schemaId, tableId));
  return schema[tableId];
}

export function GetTableModel(schemaId: string, tableId: string): TableModel {
  const model = schemaModels.get(schemaId);
  assert(model, MissingSchema(schemaId));
  assert(Object.hasOwn(model, tableId), MissingTable(schemaId, tableId));
  return model[tableId];
}

/** The physical plan of a registered table: its name, columns, key columns and indexes. */
export function GetTablePlan(schemaId: string, tableId: string): TablePlan {
  const plans = schemaPlans.get(schemaId);
  assert(plans, MissingSchema(schemaId));
  const plan = plans.get(tableId);
  assert(plan, MissingTable(schemaId, tableId));
  return plan;
}

export function GetTableNames(schemaId: string): string[] {
  return Object.keys(GetSchema(schemaId));
}

/**
 * Resolves an index by name, falling back to treating the name as a bare field.
 *
 * The contract allows `getAll`/`between`/`orderBy` to name an undeclared field,
 * which must still resolve to a usable predicate. A definition that declares no
 * indexes at all reads as an empty set rather than as nothing.
 */
export function GetIndex(
  schemaId: string,
  tableId: string,
  indexId: string,
  onlyIndex?: boolean,
): IndexDefinition {
  const indexes = GetTable(schemaId, tableId).indexes ?? {};
  if (Object.hasOwn(indexes, indexId)) {
    return indexes[indexId];
  }
  assert(!onlyIndex, `Unknown index '${indexId}' on '${schemaId}.${tableId}'`);
  return { fields: [indexId] };
}

/** The notice a table's `CROSS_INSTANCE` scans report to, built once at registration. */
export function GetCrossInstanceScanNotice(
  schemaId: string,
  tableId: string,
): CrossInstanceScanNotice {
  const notices = scanNotices.get(schemaId);
  assert(notices, MissingSchema(schemaId));
  assert(Object.hasOwn(notices, tableId), MissingTable(schemaId, tableId));
  return notices[tableId];
}

/**
 * Settles once the schema is ready and every index phase this process started for it has settled,
 * whatever their outcome. A later registration's phase finds the indexes lock held by an earlier
 * one still building and returns at once, so the earlier phase is waited for too. Nothing in the
 * query path awaits it; it is how a caller observes the phase.
 */
export async function WaitForIndexes(schemaId: string): Promise<void> {
  await WaitForSchemaReady(schemaId);
  await indexing.get(schemaId);
}

/**
 * Settles once a write to the schema can rely on its unique indexes, which is when its background
 * index phase has settled; at once for a schema that declares none.
 *
 * Reads never wait for the index phase, since an index only changes how fast they run. A unique
 * index changes what a write may store, so a write that ran before it is built could store the
 * duplicate it exists to refuse; writes to such a schema wait instead, for the index phases this
 * process started.
 */
export async function WaitForUniqueIndexes(schemaId: string): Promise<void> {
  if (guardedWrites.has(schemaId)) {
    await WaitForIndexes(schemaId);
  }
}
