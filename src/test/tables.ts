import type { PoolConnection } from "mysql2/promise";

import { type Sql, ident, int, join, param, sql } from "../statement";
import { TableName } from "../implementations/database/identifier";
import { SessionOf } from "../implementations/database/locks";
import { StartReaper } from "../implementations/database/reaper";
import { IsExternal, type Options } from "../config";
import {
  AcquireConnection,
  Connect,
  GetDialect,
  GetSchemaPrefix,
  Read,
  type Row,
} from "../connection";

const DIGITS = sql`(SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)`;

/** The physical name of a schema's table under the configured prefix. */
export function PhysicalTable(schemaId: string, tableId = "items"): string {
  return TableName(GetSchemaPrefix(), schemaId, tableId);
}

/** Runs a statement that answers no rows, on `held` or else on a pooled connection of its own. */
export async function Run(
  statement: Sql,
  held?: PoolConnection,
): Promise<void> {
  const connection = held ?? (await AcquireConnection());
  try {
    await SessionOf(connection).apply(statement);
  } finally {
    if (!held) {
      connection.release();
    }
  }
}

/** A derived table of `n` from 0 to `10 ** places - 1`, to seed rows with one statement. */
export function Numbers(places: number): Sql {
  const aliases = Array.from({ length: places }, (_, place) =>
    ident(`p${place}`),
  );
  const sum = join(
    aliases.map((alias, place) => sql`${int(10 ** place)} * ${alias}.d`),
    sql` + `,
  );
  const from = join(
    aliases.map((alias) => sql`${DIGITS} AS ${alias}`),
    sql` CROSS JOIN `,
  );
  return sql`(SELECT ${sum} AS n FROM ${from})`;
}

/** What the catalog and the rows of one table read back as, in a stable order. */
export interface TableSnapshot {
  readonly columns: readonly (readonly string[])[];
  readonly indexes: readonly (readonly string[])[];
  readonly triggers: readonly (readonly string[])[];
  readonly rows: readonly (readonly string[])[];
}

function Cells(rows: readonly Row[]): string[][] {
  return rows.map((row) =>
    [...row.values()].map((cell) =>
      Buffer.isBuffer(cell) ? cell.toString("utf8") : String(cell),
    ),
  );
}

/** The expression a functional key part indexes, which MariaDB's catalog has no column for. */
export function IndexExpression(): Sql {
  return GetDialect().id === "mysql" ? sql`EXPRESSION` : sql`NULL`;
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
    sql`SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, ${IndexExpression()} AS EXPRESSION, INDEX_COMMENT FROM information_schema.STATISTICS WHERE ${where} ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    held,
  );
  const triggers = await Read(
    sql`SELECT TRIGGER_NAME, EVENT_MANIPULATION FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ${param(table)} ORDER BY TRIGGER_NAME`,
    held,
  );
  const rows = await Read(
    sql`SELECT * FROM ${ident(table)} ORDER BY _instance, _id`,
    held,
  );
  return {
    columns: Cells(columns),
    indexes: Cells(indexes),
    triggers: Cells(triggers),
    rows: Cells(rows),
  };
}

/**
 * Connects the live adapter again with `options`, as `construct` does: an owned instance gets its
 * reaper back, since `Disconnect` stops it.
 */
export async function Reconnect(options: Options): Promise<void> {
  await Connect(options);
  if (!IsExternal()) {
    StartReaper();
  }
}
