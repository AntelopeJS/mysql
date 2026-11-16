import { GetDialect, Read } from "../../connection";
import { PoolSession, type Session } from "../../session";
import type { Sql } from "../../statement";
import type {
  CatalogColumn,
  CatalogIndex,
  ReferenceRow,
  RelationAccess,
  RelationRow,
} from "../../dialect/external";

/**
 * What registration knows about a relation it reads and never alters.
 *
 * `key` is the primary key's columns, else those of the unique index that identifies a row as one
 * would; absent when neither exists, which is every view. `indexes` lists each usable index's
 * leading columns, for the declared-index warning.
 */
export interface CatalogRelation {
  row: RelationRow;
  columns: CatalogColumn[];
  key?: readonly string[];
  indexes: (readonly string[])[];
}

/** A unique index that names a row as a primary key does: over whole, `NOT NULL` columns. */
function IsCandidateKey(index: CatalogIndex): boolean {
  return index.unique && index.total && index.notNull;
}

/** Fewest columns first, then by name, so the same catalog always yields the same key. */
function ByKeyPreference(left: CatalogIndex, right: CatalogIndex): number {
  const width = left.columns.length - right.columns.length;
  return width !== 0 ? width : left.name.localeCompare(right.name);
}

/** The primary key, else the preferred candidate key, else nothing. */
export function KeyOf(indexes: CatalogIndex[]): CatalogIndex | undefined {
  const primary = indexes.find((index) => index.primary);
  if (primary) {
    return primary;
  }
  return indexes.filter(IsCandidateKey).sort(ByKeyPreference)[0];
}

/**
 * A relation as the server confirms what the listing read. A relation whose listed columns the
 * account may all SELECT is readable only once the server takes a `SELECT *` of it: the catalog
 * lists only the columns the account holds some privilege on, so it cannot count a column the
 * account may not touch at all. Only then are its listed columns all of its columns, so INSERT and
 * UPDATE on every listed column count only on a readable relation.
 */
export async function Confirmed<Access extends RelationAccess>(
  session: Session,
  row: Access,
): Promise<Access> {
  const readable =
    row.readable &&
    (await session.prepares(
      session.dialect.external.catalog.selection(row.schema, row.name),
    ));
  return {
    ...row,
    readable,
    insert: readable && row.insert,
    update: readable && row.update,
  };
}

/** Whether the account may DELETE from a relation it sees: once the server prepares one, since no column privilege tells it. */
export function Deletes(
  session: Session,
  row: RelationAccess,
): Promise<boolean> {
  return session.prepares(
    session.dialect.external.catalog.deletion(row.schema, row.name),
  );
}

/** Whether the account may create a table in `schema`: once the server prepares one, which creates nothing. */
export function Creates(session: Session, schema: string): Promise<boolean> {
  return session.prepares(session.dialect.external.catalog.creation(schema));
}

/** The relations a listing statement answers, each {@link Confirmed}. */
async function ParseRelations(statement: Sql): Promise<RelationRow[]> {
  const session = PoolSession();
  const catalog = session.dialect.external.catalog;
  const parsed: RelationRow[] = [];
  for (const cells of await session.read(statement)) {
    parsed.push(await Confirmed(session, catalog.parseRelation(cells)));
  }
  return parsed;
}

/** The relations named `schema.name`, as the listing reads them; a name the account cannot see is absent. */
export function ReadNamedRelationRows(
  names: readonly string[],
): Promise<RelationRow[]> {
  return ParseRelations(GetDialect().external.catalog.namedRelations(names));
}

export function ReadRelationRows(
  schemas: readonly string[] | undefined,
): Promise<RelationRow[]> {
  return ParseRelations(GetDialect().external.catalog.relations(schemas));
}

/**
 * The relations of `schemas` that the account `session` reads on sees, with what it may do as the
 * listing reads it, before {@link Confirmed}: one statement, whatever the number of relations.
 */
export async function ReadRelationAccess(
  session: Session,
  schemas: readonly string[],
): Promise<RelationAccess[]> {
  const catalog = session.dialect.external.catalog;
  const rows = await session.read(catalog.access(schemas));
  return rows.map((cells) => catalog.parseAccess(cells));
}

export async function ReadColumns(row: RelationRow): Promise<CatalogColumn[]> {
  const catalog = GetDialect().external.catalog;
  const rows = await Read(catalog.columns(row.schema, row.name));
  const columns = rows.map((column) => catalog.parseColumn(column));
  const json = catalog.jsonColumns;
  if (!json || row.kind === "view" || !row.readable) {
    return columns;
  }
  const named = json.parse(await Read(json.read(row.schema, row.name)));
  return columns.map((column) =>
    named.has(column.name)
      ? { ...column, native: JSON_TYPE, dataType: JSON_TYPE }
      : column,
  );
}

/** The type a JSON column has in the catalog of an engine that keeps one. */
const JSON_TYPE = "json";

export async function ReadIndexes(row: RelationRow): Promise<CatalogIndex[]> {
  const catalog = GetDialect().external.catalog;
  return catalog.parseIndexes(
    await Read(catalog.indexes(row.schema, row.name)),
  );
}

export async function ReadReferences(
  row: RelationRow,
): Promise<ReferenceRow[]> {
  const catalog = GetDialect().external.catalog;
  return catalog.parseReferences(
    await Read(catalog.references(row.schema, row.name)),
  );
}

/**
 * Reads a relation's columns, key and indexes out of the catalog, or nothing when the account sees
 * no relation of that name. Only the catalog is read.
 */
export async function ReadRelation(
  schema: string,
  table: string,
): Promise<CatalogRelation | undefined> {
  const row = (await ReadNamedRelationRows([`${schema}.${table}`])).find(
    (found) => found.schema === schema && found.name === table,
  );
  if (!row) {
    return undefined;
  }
  const [columns, indexes] = await Promise.all([
    ReadColumns(row),
    ReadIndexes(row),
  ]);
  return {
    row,
    columns,
    key: KeyOf(indexes)?.columns,
    indexes: indexes
      .filter((index) => index.columns.length > 0)
      .map((index) => index.columns),
  };
}
