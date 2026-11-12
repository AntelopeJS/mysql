import type { Row } from "../../connection";
import { ident, param, sql } from "../../statement";
import type { CatalogSyntax, ObservedColumn, ObservedIndex } from "../ddl";
import type { Flavour } from "./flavour";

const BASE_TABLE = "BASE TABLE";
/** A column the server computes; `DEFAULT_GENERATED` only marks a default that is an expression. */
const GENERATED = /\b(VIRTUAL|STORED) GENERATED\b/i;

/** A catalog cell as text: the server answers some `information_schema` columns as binary strings. */
function Text(row: Row, column: string): string {
  const cell = row.get(column);
  if (cell === null || cell === undefined) {
    return "";
  }
  return Buffer.isBuffer(cell) ? cell.toString("utf8") : String(cell);
}

function ParseColumn(row: Row): ObservedColumn {
  return {
    name: Text(row, "name"),
    type: Text(row, "type").toLowerCase(),
    generated: GENERATED.test(Text(row, "extra")),
    comment: Text(row, "comment"),
  };
}

/** Folds one row per key part into one index each, keeping the parts in key order. */
function ParseIndexes(rows: readonly Row[]): ObservedIndex[] {
  const byName = new Map<
    string,
    ObservedIndex & { columns: (string | undefined)[] }
  >();
  for (const row of rows) {
    const name = Text(row, "name");
    const column = row.get("column_name");
    const part = column === null ? undefined : Text(row, "column_name");
    const known = byName.get(name);
    if (known) {
      known.columns.push(part);
      continue;
    }
    byName.set(name, {
      name,
      unique: Number(row.get("non_unique")) === 0,
      comment: Text(row, "comment"),
      columns: [part],
    });
  }
  return [...byName.values()];
}

const COLUMN = ident("c");

export function CatalogOf(flavour: Flavour): CatalogSyntax {
  return {
    readDatabase: () => sql`SELECT DATABASE() AS name`,
    readTable: (table) =>
      sql`SELECT TABLE_TYPE AS kind, TABLE_COMMENT AS comment FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${param(table)}`,
    readColumns: (table) =>
      sql`SELECT ${COLUMN}.COLUMN_NAME AS name, ${flavour.catalogType(COLUMN, table)} AS type, ${COLUMN}.EXTRA AS extra, ${COLUMN}.COLUMN_COMMENT AS comment FROM information_schema.COLUMNS AS ${COLUMN} WHERE ${COLUMN}.TABLE_SCHEMA = DATABASE() AND ${COLUMN}.TABLE_NAME = ${param(table)} ORDER BY ${COLUMN}.ORDINAL_POSITION`,
    readIndexes: (table) =>
      sql`SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, INDEX_COMMENT AS comment, COLUMN_NAME AS column_name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${param(table)} AND INDEX_NAME <> 'PRIMARY' ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    readTriggers: (table) =>
      sql`SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ${param(table)} ORDER BY TRIGGER_NAME`,
    parseTable: ([table], columns, indexes, triggers) => {
      if (!table) {
        return undefined;
      }
      return {
        kind: Text(table, "kind") === BASE_TABLE ? "table" : "other",
        comment: Text(table, "comment"),
        columns: columns.map(ParseColumn),
        indexes: ParseIndexes(indexes),
        triggers: triggers.map((row) => Text(row, "name")),
      };
    },
  };
}
