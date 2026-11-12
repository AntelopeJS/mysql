import type {
  FanOut,
  InboundProfile,
  Measure,
  ProfileRequest,
  Reference,
  ReferenceProfile,
  RelationProfile,
  RowCount,
} from "@antelopejs/interface-database-catalog";

import type { CatalogColumn, RelationRow } from "../../dialect/external";
import { type Sql, ident, join, sql } from "../../statement";
import {
  type ColumnRoles,
  Profiled,
  type ProfiledColumn,
  ProfileColumn,
} from "./external-column-profile";
import {
  ReadColumns,
  ReadIndexes,
  ReadNamedRelationRows,
  ReadReferences,
} from "./external-catalog";
import {
  EstimateOf,
  KeyFrom,
  ReferenceOf,
  RelationName,
} from "./external-discovery";
import {
  FirstRow,
  type MeasureSession,
  NumberOf,
  Sequentially,
  ValueOf,
  WithMeasures,
} from "./external-measures";
import {
  RelationTable,
  SAMPLE_THRESHOLD_ROWS,
  type Source,
  SourceFor,
} from "./external-sample";
import { QualifiedColumn } from "./sql";

const AND = sql` AND `;
const COMMA = sql`, `;

async function CountRows(
  session: MeasureSession,
  row: RelationRow,
  estimate: number | null,
): Promise<Measure<RowCount>> {
  if (estimate !== null && estimate > SAMPLE_THRESHOLD_ROWS) {
    return { status: "ok", value: { rows: estimate, exact: false } };
  }
  const measured = await session.measure(
    sql`SELECT COUNT(*) AS row_count FROM ${RelationTable(row)}`,
  );
  return FirstRow(measured, (counted) => ({
    rows: NumberOf(counted, "row_count") ?? 0,
    exact: true,
  }));
}

/** Rows every column measure reads: the relation's own count, or the sample's. */
async function MeasuredRows(
  session: MeasureSession,
  source: Source,
  counted: Measure<RowCount>,
): Promise<number | undefined> {
  if (!source.sample) {
    return ValueOf(counted)?.rows;
  }
  const measured = await session.measure(
    sql`SELECT COUNT(*) AS row_count FROM ${source.from}`,
  );
  const rows = NumberOf(ValueOf(measured)?.[0], "row_count") ?? undefined;
  source.sample.rows = rows ?? 0;
  return rows;
}

function ColumnTuple(alias: string, columns: readonly string[]): Sql {
  return sql`(${join(
    columns.map((column) => QualifiedColumn(alias, column)),
    COMMA,
  )})`;
}

function TableOf(relation: string): Sql {
  const dot = relation.indexOf(".");
  return sql`${ident(relation.slice(0, dot))}.${ident(relation.slice(dot + 1))}`;
}

function FanOutSql(reference: Reference): Sql {
  const child = TableOf(reference.from.relation);
  const parent = TableOf(reference.to.relation);
  const childKey = ColumnTuple("c", reference.from.columns);
  const parentKey = ColumnTuple("p", reference.to.columns);
  const filled = join(
    reference.from.columns.map(
      (column) => sql`${QualifiedColumn("c", column)} IS NOT NULL`,
    ),
    AND,
  );
  const counts = sql`SELECT COUNT(*) AS n FROM ${child} AS c WHERE ${filled} GROUP BY ${childKey}`;
  return sql`SELECT
    (SELECT AVG(g.n) FROM (${counts}) AS g) AS average,
    (SELECT MAX(g.n) FROM (${counts}) AS g) AS most,
    (SELECT COUNT(*) FROM ${parent} AS p WHERE NOT EXISTS (
      SELECT 1 FROM ${child} AS c WHERE ${childKey} = ${parentKey})) AS childless`;
}

async function ProfileReference(
  session: MeasureSession,
  reference: Reference,
): Promise<ReferenceProfile> {
  const measured = await session.measure(FanOutSql(reference));
  const fanOut = FirstRow<FanOut>(measured, (row) => ({
    average: NumberOf(row, "average") ?? 0,
    max: NumberOf(row, "most") ?? 0,
    parentsWithoutChildren: NumberOf(row, "childless") ?? 0,
  }));
  return { reference, fanOut };
}

async function Inbound(references: Reference[]): Promise<InboundProfile[]> {
  const rows = await ReadNamedRelationRows(
    references.map((reference) => reference.from.relation),
  );
  const byName = new Map(rows.map((row) => [RelationName(row), row]));
  return Promise.all(
    references.map(async (reference) => {
      const row = byName.get(reference.from.relation);
      const estimate = row ? (await EstimateOf(row)).estimatedRows : null;
      return { reference, estimatedRows: estimate };
    }),
  );
}

/** The relation, refused when it does not exist or the connected account cannot read it. */
export async function NamedRow(relation: string): Promise<RelationRow> {
  const row = (await ReadNamedRelationRows([relation])).find(
    (found) => RelationName(found) === relation,
  );
  if (!row) {
    throw new Error(
      `Relation '${relation}' does not exist, or the connected account cannot see it`,
    );
  }
  if (!row.readable) {
    throw new Error(
      `Relation '${relation}' cannot be read by the connected account`,
    );
  }
  return row;
}

/** The named columns of a relation, every one when none are named; an unknown name is refused. */
export function Chosen(
  columns: CatalogColumn[],
  relation: string,
  names: readonly string[] | undefined,
): CatalogColumn[] {
  const unknown = (names ?? []).filter(
    (name) => !columns.some((column) => column.name === name),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Relation '${relation}' has no column ${unknown.join(", ")}`,
    );
  }
  return columns.filter((column) => !names || names.includes(column.name));
}

/** Everything a profile needs from the catalog, read before its transaction opens. */
interface ProfilePlan {
  relation: string;
  row: RelationRow;
  estimate: number | null;
  source: Source;
  columns: ProfiledColumn[];
  outgoing: Reference[];
  inbound: InboundProfile[];
  roles: ColumnRoles;
}

async function PlanProfile(request: ProfileRequest): Promise<ProfilePlan> {
  const row = await NamedRow(request.relation);
  const relation = RelationName(row);
  const [columns, indexes, referenceRows] = await Promise.all([
    ReadColumns(row),
    ReadIndexes(row),
    ReadReferences(row),
  ]);
  const references = referenceRows.map(ReferenceOf);
  const outgoing = references.filter(
    (reference) => reference.from.relation === relation,
  );
  const key = KeyFrom(indexes, columns)?.columns ?? [];
  const { estimatedRows } = await EstimateOf(row);
  return {
    relation,
    row,
    estimate: estimatedRows,
    source: SourceFor(row, estimatedRows, key),
    columns: Chosen(columns, request.relation, request.columns)
      .map(Profiled)
      .filter((column) => column !== undefined),
    outgoing,
    inbound: await Inbound(
      references.filter((reference) => reference.to.relation === relation),
    ),
    roles: {
      keys: new Set(key),
      references: new Set(
        outgoing.flatMap((reference) => reference.from.columns),
      ),
    },
  };
}

/**
 * Aggregates over one relation, in one read-only transaction. A relation estimated above
 * {@link SAMPLE_THRESHOLD_ROWS} is sampled; a value is named only as a category.
 */
export async function ProfileRelation(
  request: ProfileRequest,
): Promise<RelationProfile> {
  const plan = await PlanProfile(request);
  return WithMeasures(async (session) => {
    const rows = await CountRows(session, plan.row, plan.estimate);
    const measured = await MeasuredRows(session, plan.source, rows);
    const columns = await Sequentially(plan.columns, (column) =>
      ProfileColumn(session, column, plan.source, measured, plan.roles),
    );
    const references = await Sequentially(plan.outgoing, (reference) =>
      ProfileReference(session, reference),
    );
    return {
      relation: plan.relation,
      rows,
      sample: plan.source.sample,
      columns,
      references,
      inbound: plan.inbound,
    };
  });
}
