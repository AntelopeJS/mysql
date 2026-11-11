import type {
  IndexDefinition,
  SchemaDefinition,
  TableDefinition,
} from "@antelopejs/interface-database/schema";

import type { SessionSyntax } from "../../dialect";
import { IsArray, type SqlType } from "./types";
import { type KeyColumn, type KeyPart, KeyParts } from "./paths";
import { PhysicalOrder, type SchemaModel, type TableModel } from "./fields";
import { CrossInstanceIndexName, IndexName, TableName } from "./identifier";
import {
  EXTRA_COLUMN,
  ID_COLUMN,
  INSTANCE_COLUMN,
  MAX_INSTANCE_ID_CHARS,
  MAX_KEY_CHARS,
} from "./utils";

/** One stored column, by the role it plays in a row. Key columns are planned apart, in {@link TablePlan.keyColumns}. */
type ColumnPlan =
  | {
      readonly role: "id" | "instance";
      readonly name: string;
      readonly chars: number;
    }
  | { readonly role: "extra"; readonly name: string }
  | {
      readonly role: "declared";
      readonly name: string;
      readonly field: string;
      readonly type: SqlType;
    };

/** A column that stores a declared field. */
export type DeclaredColumn = Extract<ColumnPlan, { role: "declared" }>;

/**
 * One physical index. `parts` is the key in order, `_instance` first on the index of every
 * declaration; the unprefixed twin of a `crossInstance` declaration is never unique, since rows of
 * different instances may share a key. `signature` is stored with the index and changes whenever
 * anything the index is built from changes.
 */
export interface IndexPlan {
  readonly id: string;
  readonly name: string;
  readonly unique: boolean;
  readonly parts: readonly KeyPart[];
  readonly signature: string;
}

/** The whole physical description of one table, a pure function of its declaration. */
export interface TablePlan {
  readonly schemaId: string;
  readonly tableId: string;
  readonly table: string;
  readonly columns: readonly ColumnPlan[];
  readonly keyColumns: readonly KeyColumn[];
  readonly indexes: readonly IndexPlan[];
}

/** A declared index the engine cannot build, reported once at registration; the table works without it. */
export interface IndexRefusal {
  readonly table: string;
  readonly index: string;
  readonly reason: string;
}

export interface PlannedTable {
  readonly plan: TablePlan;
  readonly refusals: readonly IndexRefusal[];
}

export interface SchemaPlan {
  readonly tables: readonly TablePlan[];
  readonly refusals: readonly IndexRefusal[];
}

/** What a plan depends on beyond the declaration: the table prefix and the engine's limits. */
export interface PlanContext {
  readonly prefix: string;
  readonly session: SessionSyntax;
}

const SIGNATURE_PREFIX = "antelopejs:1";
const UNIQUE_MARKER = "unique:";

const ID_PLAN: ColumnPlan = {
  role: "id",
  name: ID_COLUMN,
  chars: MAX_KEY_CHARS,
};
const INSTANCE_PLAN: ColumnPlan = {
  role: "instance",
  name: INSTANCE_COLUMN,
  chars: MAX_INSTANCE_ID_CHARS,
};
const EXTRA_PLAN: ColumnPlan = { role: "extra", name: EXTRA_COLUMN };
const INSTANCE_PART: KeyPart = { kind: "instance", column: INSTANCE_COLUMN };

/**
 * The fields an index keys on, in order — the name itself when the definition declares none, so
 * the DDL that creates the index and the reader that sorts by it expand it the same way.
 */
export function IndexFields(indexId: string, index: IndexDefinition): string[] {
  const declared = index.fields ?? [];
  return declared.length > 0 ? declared : [indexId];
}

/**
 * Whether a physical index keyed without `_instance` backs this declared index. Every index leads
 * with `_instance` unless the declaration asks for the unprefixed twin.
 */
export function ServesCrossInstance(index: IndexDefinition): boolean {
  return index.crossInstance === true;
}

function PartSignature(part: KeyPart): string {
  switch (part.kind) {
    case "instance":
    case "stored":
      return part.column;
    case "key":
      return part.key.name;
    case "elements":
      return `${part.column}[${part.elem.kind}]`;
  }
}

function PhysicalIndex(
  id: string,
  name: string,
  parts: readonly KeyPart[],
  unique = false,
): IndexPlan {
  const method = parts.some((part) => part.kind === "elements")
    ? "mv"
    : "btree";
  const marker = unique ? UNIQUE_MARKER : "";
  return {
    id,
    name,
    unique,
    parts,
    signature: `${SIGNATURE_PREFIX}:${method}:${marker}${parts.map(PartSignature).join(",")}`,
  };
}

type ElementPart = Extract<KeyPart, { kind: "elements" }>;

/**
 * The elements of the one declared array of strings a `multi` index keys on, as its key part.
 *
 * Only strings: MySQL casts multi-valued elements to `CHAR`, `DECIMAL`, dates and integers but not
 * to `DOUBLE`, and refuses a write whose array holds an object. Any other array is keyed whole.
 */
function ElementPartOf(
  fields: readonly string[],
  index: IndexDefinition,
  model: TableModel,
): ElementPart | undefined {
  const [field] = fields;
  if (
    index.multi !== true ||
    fields.length !== 1 ||
    !Object.hasOwn(model.fields, field)
  ) {
    return undefined;
  }
  const { column, type } = model.fields[field];
  return IsArray(type) && type.elem.kind === "text"
    ? { kind: "elements", field, column, elem: type.elem }
    : undefined;
}

interface PlannedIndex {
  readonly indexes: readonly IndexPlan[];
  readonly refusal?: string;
}

function PlanIndex(
  tableId: string,
  indexId: string,
  index: IndexDefinition,
  model: TableModel,
  session: SessionSyntax,
): PlannedIndex {
  const fields = IndexFields(indexId, index);
  const unique = index.unique === true;
  const elements = ElementPartOf(fields, index, model);
  if (elements && unique) {
    throw new Error(
      `Index '${indexId}' on table '${tableId}' is unique and multi over an array field, whose elements MySQL cannot hold unique; drop one of the two flags`,
    );
  }
  if (elements && !session.multiValuedIndex) {
    return {
      indexes: [],
      refusal: `this engine has no multi-valued index for the elements of '${elements.field}'`,
    };
  }
  const parts = elements
    ? [elements]
    : KeyParts(indexId, fields, unique, model, session);
  const scoped = PhysicalIndex(
    indexId,
    IndexName(indexId),
    [INSTANCE_PART, ...parts],
    unique,
  );
  if (!ServesCrossInstance(index)) {
    return { indexes: [scoped] };
  }
  const twin = PhysicalIndex(indexId, CrossInstanceIndexName(indexId), parts);
  return { indexes: [scoped, twin] };
}

function DistinctKeyColumns(indexes: readonly IndexPlan[]): KeyColumn[] {
  const byName = new Map<string, KeyColumn>();
  for (const part of indexes.flatMap((index) => index.parts)) {
    if (part.kind === "key") {
      byName.set(part.key.name, part.key);
    }
  }
  return [...byName.values()];
}

/** Refuses two names MySQL would read as one: names compare without case. */
function AssertDistinct(claims: readonly (readonly [string, string])[]): void {
  const owners = new Map<string, string>();
  for (const [name, claimant] of claims) {
    const folded = name.toLowerCase();
    const owner = owners.get(folded);
    if (owner !== undefined) {
      throw new Error(
        `The physical name '${name}' is claimed by both ${owner} and ${claimant}; rename one`,
      );
    }
    owners.set(folded, claimant);
  }
}

/**
 * Rejects a table whose columns, or whose indexes, do not all get distinct names: a key column
 * named like a declared column, or two index ids that differ only in case or in their cut tail.
 */
function AssertDistinctNames(plan: TablePlan): void {
  AssertDistinct([
    ...plan.columns.map(
      (column) => [column.name, `column '${column.name}'`] as const,
    ),
    ...plan.keyColumns.map(
      (key) => [key.name, `the key column of '${key.source}'`] as const,
    ),
  ]);
  AssertDistinct(
    plan.indexes.map(
      (index) =>
        [index.name, `index '${index.id}' on table '${plan.tableId}'`] as const,
    ),
  );
}

/**
 * Plans one table: its stored columns in physical order, its indexes, and the key columns those
 * indexes need. Pure, so a plan is tested without a server.
 */
export function BuildTablePlan(
  schemaId: string,
  tableId: string,
  definition: TableDefinition,
  model: TableModel,
  context: PlanContext,
): PlannedTable {
  const declared: ColumnPlan[] = Object.entries(model.fields).map(
    ([field, spec]) => ({
      role: "declared",
      name: spec.column,
      field,
      type: spec.type,
    }),
  );
  const refusals: IndexRefusal[] = [];
  const indexes = Object.entries(definition.indexes ?? {}).flatMap(
    ([indexId, index]) => {
      const planned = PlanIndex(
        tableId,
        indexId,
        index,
        model,
        context.session,
      );
      if (planned.refusal !== undefined) {
        refusals.push({
          table: tableId,
          index: indexId,
          reason: planned.refusal,
        });
      }
      return planned.indexes;
    },
  );
  const plan: TablePlan = {
    schemaId,
    tableId,
    table: TableName(context.prefix, schemaId, tableId),
    columns: PhysicalOrder(ID_PLAN, INSTANCE_PLAN, declared, EXTRA_PLAN),
    keyColumns: DistinctKeyColumns(indexes),
    indexes,
  };
  AssertDistinctNames(plan);
  return { plan, refusals };
}

/**
 * Turns a whole registered schema into the plans of its tables. Pure, and the only supported way
 * to build them: every table is checked for distinct names, and the tables against each other,
 * since the schema id and table id share one table name.
 */
export function BuildSchemaPlan(
  schemaId: string,
  schema: SchemaDefinition,
  model: SchemaModel,
  context: PlanContext,
): SchemaPlan {
  const built = Object.entries(schema).map(([tableId, definition]) =>
    BuildTablePlan(schemaId, tableId, definition, model[tableId], context),
  );
  const tables = built.map(({ plan }) => plan);
  AssertDistinct(
    tables.map((plan) => [plan.table, `table '${plan.tableId}'`] as const),
  );
  return { tables, refusals: built.flatMap(({ refusals }) => refusals) };
}
