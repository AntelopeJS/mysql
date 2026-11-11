import type { Sql } from "../statement";
import type { Row } from "../connection";
import type { KeyColumn } from "../implementations/database/paths";
import type {
  DeclaredColumn,
  IndexPlan,
  TablePlan,
} from "../implementations/database/plan";

/** A column as the catalog reports it. `type` is the engine's full column type, lowercased. */
export interface ObservedColumn {
  readonly name: string;
  readonly type: string;
  readonly generated: boolean;
  readonly comment: string;
}

/** A secondary index as the catalog reports it. A part over an expression has no column name. */
export interface ObservedIndex {
  readonly name: string;
  readonly unique: boolean;
  readonly comment: string;
  readonly columns: readonly (string | undefined)[];
}

/** What sits at a table name: `table` for a base table, `other` for a view or anything else. */
export interface ObservedTable {
  readonly kind: "table" | "other";
  readonly comment: string;
  readonly columns: readonly ObservedColumn[];
  readonly indexes: readonly ObservedIndex[];
}

/** A row's primary key, in key order. */
export interface RowKey {
  readonly instance: string;
  readonly id: string;
}

/**
 * What a failed convergence statement means.
 *
 * - `lockTimeout`: it waited too long for a lock and changed nothing; try again later.
 * - `present`: what it creates already exists. `absent`: what it drops is already gone.
 * - `interrupted`: the statement was killed.
 * - `refused`: the server rejected this statement and the session is still usable.
 * - `broken`: anything else, the session included.
 */
export type DdlFailure =
  | "lockTimeout"
  | "present"
  | "absent"
  | "interrupted"
  | "refused"
  | "broken";

/** The registry table instance ids are recorded in, by its column names. */
export interface InstancesTable {
  readonly table: string;
  readonly schema: string;
  readonly instance: string;
  readonly created: string;
}

/** The statements convergence runs. Each one is applied by the server atomically or not at all. */
export interface DdlSyntax {
  /** The table with every column, key column and index of the plan, its comment set to `comment`. */
  createTable(plan: TablePlan, comment: string): Sql;
  /** Adds a declared column, nullable, with `comment`. */
  addColumn(table: string, column: DeclaredColumn, comment: string): Sql;
  /** Restates a declared column with its declared type and `comment`; the server converts the values. */
  modifyColumn(table: string, column: DeclaredColumn, comment: string): Sql;
  /** Adds a generated key column, signed with its definition. */
  addKeyColumn(table: string, key: KeyColumn): Sql;
  /** Drops `indexes` and then `columns`, in one statement. */
  dropColumns(
    table: string,
    columns: readonly string[],
    indexes: readonly string[],
  ): Sql;
  /** Builds an index, signed in the same statement, without blocking writes where the engine can. */
  addIndex(table: string, index: IndexPlan): Sql;
  /** Drops an index and builds its replacement under the same name, in one statement. */
  swapIndex(table: string, index: IndexPlan): Sql;
  dropIndex(table: string, name: string): Sql;
  /** The key of the `rows`-th row after `after`, in key order: where one backfill chunk ends. */
  backfillBound(table: string, after: RowKey | undefined, rows: number): Sql;
  /**
   * Moves a declared field's values out of `_extra` into its column, for the rows after `after` up
   * to `through`. A value the column cannot hold stays in `_extra`, and a row already moved no longer
   * matches, so the statement can run again over the same rows.
   */
  backfillChunk(
    table: string,
    column: DeclaredColumn,
    after: RowKey | undefined,
    through: RowKey | undefined,
  ): Sql;
  /** How long a DDL statement of this session waits for a metadata lock; `undefined` restores the server's. */
  lockWait(seconds: number | undefined): Sql;
  /** Stops the statement another session is running. */
  killQuery(connectionId: number): Sql;
  /** The table instance ids are recorded in, created when absent. */
  createInstances(registry: InstancesTable): Sql;
  failure(error: Error): DdlFailure;
}

/** The queries that observe one owned table, and the parser that reads their rows back. */
export interface CatalogSyntax {
  readTable(table: string): Sql;
  readColumns(table: string): Sql;
  readIndexes(table: string): Sql;
  /** `undefined` when nothing sits at the name. */
  parseTable(
    table: readonly Row[],
    columns: readonly Row[],
    indexes: readonly Row[],
  ): ObservedTable | undefined;
}
