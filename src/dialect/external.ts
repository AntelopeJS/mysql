import type { CatalogInfo } from "@antelopejs/interface-database-catalog";

import type { Row } from "../connection";
import type { Sql } from "../statement";
import type { SqlType } from "../implementations/database/types";
import type { Ordering } from "../implementations/database/json";

/**
 * The native types external mode tells apart, each standing for the engine types it reads alike. A
 * column whose type is in none of them is refused at registration, whatever it is declared as.
 */
export type NativeFamily =
  | "text"
  | "enum"
  | "set"
  | "rendered"
  | "bool"
  | "int"
  | "bigint"
  | "decimal"
  | "float"
  | "double"
  | "date"
  | "datetime"
  | "timestamp"
  | "json";

/** One column of a relation the adapter did not create, as the engine's catalog describes it. */
export interface CatalogColumn {
  readonly name: string;
  /** The column's full type, modifiers included, e.g. `varchar(200)` or `decimal(12,2) unsigned`. */
  readonly native: string;
  /** The type's bare name, e.g. `varchar`. */
  readonly dataType: string;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
  /** The expression the server evaluates for a default, where the default is one. */
  readonly defaultExpression: string | null;
  readonly generated: boolean;
  readonly autoIncrement: boolean;
  readonly comment: string | null;
  /** An enum's labels, in their sort order. */
  readonly enumLabels: readonly string[] | null;
  /** A text column's character set and collation, which a value compared with it or written to it is converted into. */
  readonly charset: string | null;
  readonly collation: string | null;
}

/** An index of a relation; `columns` is empty when any part is an expression. */
export interface CatalogIndex {
  readonly name: string;
  readonly primary: boolean;
  readonly unique: boolean;
  /** Every part is a column, and the index is visible to the optimizer. */
  readonly total: boolean;
  readonly notNull: boolean;
  readonly columns: readonly string[];
}

/** The kinds of relation an engine lists, as the catalog interface names them. */
export type ExternalRelationKind = "table" | "partitioned" | "view";

/** One relation as a listing reads it: its kind, what the connected account may do, its estimate. */
export interface RelationRow {
  readonly schema: string;
  readonly name: string;
  readonly kind: ExternalRelationKind;
  readonly readable: boolean;
  /** SELECT is granted on some of its columns, which does not make it readable. */
  readonly someColumns: boolean;
  readonly insert: boolean;
  readonly update: boolean;
  readonly delete: boolean;
  /** The engine's own row estimate, absent for a relation that keeps none. */
  readonly statistics: number | null;
  readonly comment: string | null;
}

/** A declared foreign key, its columns in key order. */
export interface ReferenceRow {
  readonly name: string;
  readonly fromRelation: string;
  readonly fromColumns: readonly string[];
  readonly toRelation: string;
  readonly toColumns: readonly string[];
}

/** Reads the engine's catalog and parses what it answers into the shapes above. */
export interface ExternalCatalogSyntax {
  /** Every relation in `schemas`, or in every schema but the engine's own when absent. */
  relations(schemas: readonly string[] | undefined): Sql;
  /** The relations named `schema.name`. */
  namedRelations(names: readonly string[]): Sql;
  readonly parseRelation: (row: Row) => RelationRow;
  columns(schema: string, table: string): Sql;
  readonly parseColumn: (row: Row) => CatalogColumn;
  indexes(schema: string, table: string): Sql;
  parseIndexes(rows: readonly Row[]): CatalogIndex[];
  /** Foreign keys out of and into a relation. */
  references(schema: string, table: string): Sql;
  parseReferences(rows: readonly Row[]): ReferenceRow[];
  info(): Sql;
  parseInfo(row: Row): Omit<CatalogInfo, "engine">;
  /** The optimizer's row estimate for reading a relation whole. */
  plannedRows(schema: string, table: string): Sql;
  parsePlannedRows(rows: readonly Row[]): number | null;
}

/** Turns the other operand of a comparison, read as the declared kind, into the column's own type. */
export type Conversion = (other: Sql, operator: Ordering) => Sql;

/** A constant a write gives a column, before it reaches the server, tagged with what it is. */
export type CheckedValue =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "date"; readonly value: Date };

/** Why a value cannot be held by a column, or nothing when it can. */
export type ValueCheck = (value: CheckedValue) => string | undefined;

/**
 * How a column is read as one declared kind, compared, aggregated and written.
 *
 * `value` is the column read as the kind; `conversion` lets a comparison keep the column bare, so
 * the client's index serves it; `numeric` lets an aggregate read the column itself, exactly;
 * `writing` brings a written value into the column's type, absent for a column no write assigns,
 * whose reason `readOnly` gives; `check` is what a written constant must pass before the statement
 * runs.
 */
export interface ColumnReading {
  readonly family: NativeFamily;
  readonly value: (column: Sql) => Sql;
  /**
   * Where the column holds a value its read answers, for a column that can hold one it reads as
   * absent: a comparison through the bare column holds only there.
   */
  readonly present?: (column: Sql) => Sql;
  readonly lossy?: string;
  readonly conversion?: Conversion;
  readonly numeric: boolean;
  readonly writing?: (value: Sql) => Sql;
  readonly readOnly?: string;
  readonly check?: ValueCheck;
}

/** The engine's type policy: which column types read as which declared kinds, and how. */
export interface ExternalTypeSyntax {
  family(column: CatalogColumn): NativeFamily | undefined;
  /** The column read as `kind`, or nothing for a pairing registration refuses. */
  reading(kind: SqlType, column: CatalogColumn): ColumnReading | undefined;
  /** The column read as the text `_id` is built from, or nothing when it cannot serve as a key. */
  keyReading(column: CatalogColumn): ColumnReading | undefined;
  /** The kind a generator proposes first for a family. */
  proposed(family: NativeFamily): SqlType;
  /** A value at the precision a read of `kind` answers it, which is what "unchanged" means. */
  asRead(kind: SqlType, value: Sql): Sql;
  /**
   * Whether two values of `kind` read alike, NULL equal to NULL: at the precision a read answers,
   * and text code point for code point, whatever the column's collation equates.
   */
  sameRead(kind: SqlType, left: Sql, right: Sql): Sql;
  /** A composite key's `_id`: its parts' texts, as the text of one JSON array. */
  compositeId(parts: readonly Sql[]): Sql;
  /**
   * The parts of a composite `_id`, each its text; every part is SQL NULL when `id` is not the
   * text of a JSON array of exactly `width` strings, and never an error.
   */
  idParts(id: Sql, width: number): Sql[];
}

/** What a failed write means, in terms a caller acts on without reading the engine's errnos. */
export type ExternalFailureKind =
  | "invalid"
  | "missing"
  | "duplicate"
  | "reference"
  | "referenced"
  | "check"
  | "forbidden";

/** A failed write as {@link ExternalSyntax.failure} reads it off the server's error. */
export interface ExternalFailure {
  readonly kind: ExternalFailureKind;
  readonly code: string;
  readonly column?: string;
  readonly constraint?: string;
}

/** The statements a profile's read-only session runs, and the errors that mean it ran out of time. */
export interface ExternalMeasureSyntax {
  /** Opens a read-only transaction whose reads stop after `timeoutMs` and wait for no lock long. */
  open(timeoutMs: number): readonly Sql[];
  readonly close: Sql;
  /** The code a failed measure answers with, and whether it means the measure ran out of time. */
  failure(error: Error): { readonly code: string; readonly timeout: boolean };
  /** A filter keeping about one row in `every`, the same rows every time, chosen by `key`. */
  sampled(key: Sql, every: number): Sql;
  /** A filter keeping about `share` of the rows, for a relation with no key to sample by. */
  sampledRandomly(share: number): Sql;
  /** Characters in a text. */
  length(text: Sql): Sql;
  /** Bytes in a binary value. */
  bytes(value: Sql): Sql;
  /** An instant's UTC calendar month, `YYYY-MM`. */
  month(instant: Sql): Sql;
}

/** External mode's engine syntax: the catalog, the type policy, write failures and measures. */
export interface ExternalSyntax {
  readonly engine: string;
  readonly catalog: ExternalCatalogSyntax;
  readonly types: ExternalTypeSyntax;
  readonly measures: ExternalMeasureSyntax;
  /** A failed external write as what it means, or nothing for an error that means none of these. */
  failure(error: Error): ExternalFailure | undefined;
}
