import type { SampleInfo } from "@antelopejs/interface-database-catalog";

import { GetDialect } from "../../connection";
import type { RelationRow } from "../../dialect/external";
import { type Sql, ident, int, sql } from "../../statement";
import { QualifiedColumn } from "./sql";

/** Above this many estimated rows a relation is sampled rather than read whole. */
export const SAMPLE_THRESHOLD_ROWS = 1_000_000;
const SAMPLE_TARGET_ROWS = 100_000;
const PERCENT = 100;

/** The alias every measure reads its relation under. */
export const SOURCE_ALIAS = "r";

/** What every measure reads `FROM`, and how it was cut down. */
export interface Source {
  from: Sql;
  sample: SampleInfo | null;
}

export function RelationTable(row: RelationRow): Sql {
  return sql`${ident(row.schema)}.${ident(row.name)}`;
}

function Kept(row: RelationRow, key: readonly string[], estimate: number): Sql {
  const measures = GetDialect().external.measures;
  if (key.length === 0) {
    return measures.sampledRandomly(SAMPLE_TARGET_ROWS / estimate);
  }
  const columns = key.map((column) => QualifiedColumn(SOURCE_ALIAS, column));
  const text =
    columns.length === 1
      ? columns[0]
      : GetDialect().sql.scalar.concat(
          columns.flatMap((column, position) =>
            position === 0 ? [column] : [sql`','`, column],
          ),
        );
  return measures.sampled(text, Math.ceil(estimate / SAMPLE_TARGET_ROWS));
}

/**
 * A relation's rows, sampled above {@link SAMPLE_THRESHOLD_ROWS}. MySQL has no block sampling, so a
 * table keeps the rows whose key hashes into one bucket of as many as it takes to read about
 * {@link SAMPLE_TARGET_ROWS}, the same rows every time, which still scans the table under the
 * measure's timeout; a table without a key keeps a seeded random share. A view is read up to its
 * first {@link SAMPLE_TARGET_ROWS} rows.
 */
export function SourceFor(
  row: RelationRow,
  estimate: number | null,
  key: readonly string[],
  alias = SOURCE_ALIAS,
): Source {
  const table = RelationTable(row);
  if (estimate === null || estimate <= SAMPLE_THRESHOLD_ROWS) {
    return { from: sql`${table} AS ${ident(alias)}`, sample: null };
  }
  const percent = Math.min(PERCENT, (SAMPLE_TARGET_ROWS / estimate) * PERCENT);
  const sample = { percent, rows: 0 };
  if (row.kind === "view") {
    return {
      from: sql`(SELECT * FROM ${table} LIMIT ${int(SAMPLE_TARGET_ROWS)}) AS ${ident(alias)}`,
      sample,
    };
  }
  const kept = Kept(row, key, estimate);
  return {
    from: sql`(SELECT * FROM ${table} AS ${ident(SOURCE_ALIAS)} WHERE ${kept}) AS ${ident(alias)}`,
    sample,
  };
}
