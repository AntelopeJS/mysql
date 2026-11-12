import type {
  ColumnReference,
  Measure,
  ReferenceCheck,
  ReferenceMatch,
} from "@antelopejs/interface-database-catalog";

import { GetDialect } from "../../connection";
import type { CatalogColumn, RelationRow } from "../../dialect/external";
import { type Sql, sql } from "../../statement";
import { ReadColumns, ReadIndexes } from "./external-catalog";
import { EstimateOf, KeyFrom } from "./external-discovery";
import { FirstRow, NumberOf, WithMeasures } from "./external-measures";
import { NamedRow } from "./external-profile";
import { RelationTable, SourceFor } from "./external-sample";
import { QualifiedColumn } from "./sql";

/** One side of a reference check, resolved against the catalog. */
interface Side {
  row: RelationRow;
  column: CatalogColumn;
  columns: CatalogColumn[];
}

async function Resolve(reference: ColumnReference): Promise<Side> {
  const row = await NamedRow(reference.relation);
  const columns = await ReadColumns(row);
  const column = columns.find(
    (candidate) => candidate.name === reference.column,
  );
  if (!column) {
    throw new Error(
      `Relation '${reference.relation}' has no column ${reference.column}`,
    );
  }
  return { row, column, columns };
}

async function KeyOfSide(side: Side): Promise<readonly string[]> {
  return KeyFrom(await ReadIndexes(side.row), side.columns)?.columns ?? [];
}

/** Native equality when both columns share a type, so the target's index serves it; text otherwise. */
function Equality(from: Side, to: Side): Sql {
  const left = QualifiedColumn("t", to.column.name);
  const right = QualifiedColumn("f", from.column.name);
  if (from.column.native === to.column.native) {
    return sql`${left} = ${right}`;
  }
  const scalar = GetDialect().sql.scalar;
  return sql`${scalar.cast(left, "text")} = ${scalar.cast(right, "text")}`;
}

/**
 * How many of a column's non-null values another column holds, for a reference the database does
 * not declare, in the same read-only transaction a profile uses.
 */
export async function CheckColumnReference(
  check: ReferenceCheck,
): Promise<Measure<ReferenceMatch>> {
  const from = await Resolve(check.from);
  const to = await Resolve(check.to);
  const source = SourceFor(
    from.row,
    (await EstimateOf(from.row)).estimatedRows,
    await KeyOfSide(from),
    "f",
  );
  const targetKey = await KeyOfSide(to);
  const targetIsKey = targetKey.length === 1 && targetKey[0] === to.column.name;
  const found = sql`EXISTS (SELECT 1 FROM ${RelationTable(to.row)} AS t WHERE ${Equality(from, to)})`;
  const statement = sql`SELECT COUNT(*) AS checked, SUM(CASE WHEN ${found} THEN 1 ELSE 0 END) AS found
    FROM ${source.from} WHERE ${QualifiedColumn("f", from.column.name)} IS NOT NULL`;
  return WithMeasures(async (session) =>
    FirstRow(await session.measure(statement), (row) => {
      const checked = NumberOf(row, "checked") ?? 0;
      const matched = NumberOf(row, "found") ?? 0;
      return {
        containment: checked > 0 ? matched / checked : 0,
        checkedRows: checked,
        sampled: source.sample !== null,
        targetIsKey,
      };
    }),
  );
}
