import type { PoolConnection } from "mysql2/promise";

import { Read, type Row } from "../connection";
import { ident, param, sql } from "../statement";

/** What the catalog and the rows of one table read back as, in a stable order. */
export interface TableSnapshot {
  readonly columns: readonly (readonly string[])[];
  readonly indexes: readonly (readonly string[])[];
  readonly rows: readonly (readonly string[])[];
}

function Cells(rows: readonly Row[]): string[][] {
  return rows.map((row) =>
    [...row.values()].map((cell) =>
      Buffer.isBuffer(cell) ? cell.toString("utf8") : String(cell),
    ),
  );
}

/** The table's columns, indexes and every row, read on `held` when given. */
export async function Snapshot(
  table: string,
  held?: PoolConnection,
): Promise<TableSnapshot> {
  const where = sql`TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${param(table)}`;
  const columns = await Read(
    sql`SELECT COLUMN_NAME, COLUMN_TYPE, EXTRA, COLUMN_COMMENT, GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE ${where} ORDER BY ORDINAL_POSITION`,
    held,
  );
  const indexes = await Read(
    sql`SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, EXPRESSION, INDEX_COMMENT FROM information_schema.STATISTICS WHERE ${where} ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    held,
  );
  const rows = await Read(
    sql`SELECT * FROM ${ident(table)} ORDER BY _instance, _id`,
    held,
  );
  return {
    columns: Cells(columns),
    indexes: Cells(indexes),
    rows: Cells(rows),
  };
}
