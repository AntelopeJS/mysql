import {
  type MeasureError,
  type MeasureTimeout,
  type RowSample,
  SAMPLE_ROWS_LIMIT,
  SAMPLE_TEXT_LENGTH,
  type SampledValue,
  type SampleRequest,
} from "@antelopejs/interface-database-catalog";

import { GetDialect, type Row } from "../../connection";
import type { CatalogColumn } from "../../dialect/external";
import { type Sql, ident, join, param, sql } from "../../statement";
import { ReadColumns, ReadIndexes } from "./external-catalog";
import { EstimateOf, KeyFrom, RelationName } from "./external-discovery";
import { WithMeasures } from "./external-measures";
import { Chosen, NamedRow } from "./external-profile";
import { SOURCE_ALIAS, SourceFor } from "./external-sample";
import { QualifiedColumn } from "./sql";

/** Column types whose values are bytes, which a sample answers by their length only. */
const BINARY_TYPES: readonly string[] = [
  "binary",
  "varbinary",
  "tinyblob",
  "blob",
  "mediumblob",
  "longblob",
  "bit",
  "geometry",
  "point",
  "linestring",
  "polygon",
  "multipoint",
  "multilinestring",
  "multipolygon",
  "geometrycollection",
];

interface SampledColumn {
  name: string;
  binary: boolean;
}

function SampledColumnOf(column: CatalogColumn): SampledColumn {
  return { name: column.name, binary: BINARY_TYPES.includes(column.dataType) };
}

function CheckedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > SAMPLE_ROWS_LIMIT) {
    throw new Error(
      `A sample answers from 1 to ${SAMPLE_ROWS_LIMIT} rows, not ${limit}`,
    );
  }
  return limit;
}

function Alias(index: number): string {
  return `c${index}`;
}

function Expression(column: SampledColumn, index: number): Sql {
  const dialect = GetDialect();
  const value = QualifiedColumn(SOURCE_ALIAS, column.name);
  const read = column.binary
    ? dialect.external.measures.bytes(value)
    : dialect.sql.scalar.left(
        dialect.sql.scalar.cast(value, "text"),
        SAMPLE_TEXT_LENGTH + 1,
      );
  return sql`${read} AS ${ident(Alias(index))}`;
}

function Value(column: SampledColumn, row: Row, index: number): SampledValue {
  const read = row.get(Alias(index));
  if (read === null || read === undefined) {
    return null;
  }
  if (column.binary) {
    return { bytes: Number(read) };
  }
  const text = Buffer.isBuffer(read) ? read.toString("utf8") : String(read);
  return {
    text: text.slice(0, SAMPLE_TEXT_LENGTH),
    truncated: text.length > SAMPLE_TEXT_LENGTH,
  };
}

function FailureOf(measured: MeasureTimeout | MeasureError): string {
  return measured.status === "timeout" ? "timeout" : measured.code;
}

/**
 * The first rows of a relation, or of its sample above the sampling threshold, in one read-only
 * transaction. Every value is text cut at {@link SAMPLE_TEXT_LENGTH}, and a binary one its length.
 */
export async function SampleRelationRows(
  request: SampleRequest,
): Promise<RowSample> {
  const limit = CheckedLimit(request.limit);
  const row = await NamedRow(request.relation);
  const [catalogColumns, indexes] = await Promise.all([
    ReadColumns(row),
    ReadIndexes(row),
  ]);
  const columns = Chosen(catalogColumns, request.relation, request.columns).map(
    SampledColumnOf,
  );
  const { estimatedRows } = await EstimateOf(row);
  const key = KeyFrom(indexes, catalogColumns)?.columns ?? [];
  const source = SourceFor(row, estimatedRows, key);
  const select = join(columns.map(Expression), sql`, `);
  const measured = await WithMeasures((session) =>
    session.measure(
      sql`SELECT ${select} FROM ${source.from} LIMIT ${param(limit)}`,
    ),
  );
  if (measured.status !== "ok") {
    throw new Error(
      `The sample of '${request.relation}' did not finish: ${FailureOf(measured)}`,
    );
  }
  return {
    relation: RelationName(row),
    columns: columns.map((column) => column.name),
    rows: measured.value.map((sampled) =>
      columns.map((column, index) => Value(column, sampled, index)),
    ),
    sample: source.sample && {
      ...source.sample,
      rows: measured.value.length,
    },
  };
}
