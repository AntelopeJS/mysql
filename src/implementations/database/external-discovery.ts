import type {
  CatalogInfo,
  ColumnDescription,
  EstimateSource,
  IndexDescription,
  Reference,
  RelationDescription,
  RelationKey,
  RelationSummary,
} from "@antelopejs/interface-database-catalog";

import { GetDialect, Read } from "../../connection";
import type {
  CatalogColumn,
  CatalogIndex,
  ReferenceRow,
  RelationRow,
} from "../../dialect/external";
import {
  KeyOf,
  ReadColumns,
  ReadIndexes,
  ReadReferences,
} from "./external-catalog";
import {
  AcceptedDeclarations,
  UnsupportedReason,
} from "./external-declarations";
import {
  Describe,
  DescribeKeyColumns,
  IsReadOnly,
  ReadOnlyReason,
} from "./external-types";

const PARTIAL_GRANTS = "SELECT is granted on some of its columns only";
const NOT_READABLE = "the connected account cannot SELECT from it";

export function RelationName(row: RelationRow): string {
  return `${row.schema}.${row.name}`;
}

export async function ReadInfo(): Promise<CatalogInfo> {
  const dialect = GetDialect();
  const [row] = await Read(dialect.external.catalog.info());
  return {
    engine: dialect.external.engine,
    ...dialect.external.catalog.parseInfo(row),
  };
}

/** The optimizer's row estimate, for a relation the server keeps no statistics on. */
async function PlannedRows(row: RelationRow): Promise<number | null> {
  const catalog = GetDialect().external.catalog;
  try {
    return catalog.parsePlannedRows(
      await Read(catalog.plannedRows(row.schema, row.name)),
    );
  } catch {
    return null;
  }
}

interface Estimate {
  estimatedRows: number | null;
  estimate: EstimateSource | null;
}

const NO_ESTIMATE: Estimate = { estimatedRows: null, estimate: null };

/**
 * The server's statistics where it keeps them, which is every base table, else the optimizer's
 * estimate, which is all a view has; the optimizer estimates a view only for an account that may
 * see its definition.
 */
export async function EstimateOf(row: RelationRow): Promise<Estimate> {
  if (row.statistics !== null) {
    return { estimatedRows: row.statistics, estimate: "statistics" };
  }
  if (!row.readable) {
    return NO_ESTIMATE;
  }
  const planned = await PlannedRows(row);
  return planned === null
    ? NO_ESTIMATE
    : { estimatedRows: planned, estimate: "plan" };
}

function UnmappableReason(row: RelationRow): string | undefined {
  if (row.readable) {
    return undefined;
  }
  return row.someColumns ? PARTIAL_GRANTS : NOT_READABLE;
}

/** The key registration aliases `_id` to: the same choice, over the same columns. */
export function KeyFrom(
  indexes: CatalogIndex[],
  columns: CatalogColumn[],
): RelationKey | null {
  const key = KeyOf(indexes);
  const byName = new Map(columns.map((column) => [column.name, column]));
  if (!key || !DescribeKeyColumns(GetDialect(), key.columns, byName)) {
    return null;
  }
  return {
    columns: [...key.columns],
    source: key.primary ? "primary" : "unique",
  };
}

async function SummaryOf(
  row: RelationRow,
  key: RelationKey | null,
): Promise<RelationSummary> {
  const summary: RelationSummary = {
    schema: row.schema,
    name: row.name,
    kind: row.kind,
    ...(await EstimateOf(row)),
    key,
    writes: { insert: row.insert, update: row.update, delete: row.delete },
    comment: row.comment,
  };
  const unmappable = UnmappableReason(row);
  return unmappable ? { ...summary, unmappable } : summary;
}

export async function Summarize(row: RelationRow): Promise<RelationSummary> {
  const [columns, indexes] = await Promise.all([
    ReadColumns(row),
    ReadIndexes(row),
  ]);
  return SummaryOf(row, KeyFrom(indexes, columns));
}

function ReadOnlyOf(column: CatalogColumn, path: string): string | undefined {
  const dialect = GetDialect();
  const [proposed] = AcceptedDeclarations(dialect, column);
  if (!proposed) {
    return undefined;
  }
  const descriptor = Describe(
    dialect,
    column.name,
    proposed.kind,
    column,
    path,
  );
  return IsReadOnly(descriptor) ? ReadOnlyReason(descriptor) : undefined;
}

function DescribeColumn(
  column: CatalogColumn,
  relation: string,
): ColumnDescription {
  const accepts = AcceptedDeclarations(GetDialect(), column).map(
    ({ declared, lossy }) => (lossy ? { declared, lossy } : { declared }),
  );
  const described: ColumnDescription = {
    name: column.name,
    native: column.native,
    nullable: !column.notNull,
    hasDefault: column.hasDefault,
    generated: column.generated,
    identity: column.autoIncrement ? "by default" : null,
    accepts,
    comment: column.comment,
  };
  if (column.enumLabels) {
    described.enumLabels = [...column.enumLabels];
  }
  if (accepts.length === 0) {
    described.unsupported = UnsupportedReason(column);
  }
  const readOnly = ReadOnlyOf(column, `${relation}.${column.name}`);
  if (readOnly) {
    described.readOnly = readOnly;
  }
  return described;
}

function IndexOf(index: CatalogIndex): IndexDescription {
  return {
    name: index.name,
    columns: [...index.columns],
    unique: index.unique,
  };
}

export function ReferenceOf(row: ReferenceRow): Reference {
  return {
    name: row.name,
    from: { relation: row.fromRelation, columns: [...row.fromColumns] },
    to: { relation: row.toRelation, columns: [...row.toColumns] },
  };
}

export async function DescribeRow(
  row: RelationRow,
): Promise<RelationDescription> {
  const relation = RelationName(row);
  const [columns, indexes, references] = await Promise.all([
    ReadColumns(row),
    ReadIndexes(row),
    ReadReferences(row),
  ]);
  return {
    ...(await SummaryOf(row, KeyFrom(indexes, columns))),
    columns: columns.map((column) => DescribeColumn(column, relation)),
    indexes: indexes.filter((index) => index.columns.length > 0).map(IndexOf),
    references: references
      .filter((reference) => reference.fromRelation === relation)
      .map(ReferenceOf),
    referencedBy: references
      .filter((reference) => reference.toRelation === relation)
      .map(ReferenceOf),
  };
}
