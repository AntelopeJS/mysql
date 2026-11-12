import assert from "node:assert";

import type { Dialect } from "../../dialect";
import type { Sql } from "../../statement";
import type { SqlType } from "./types";
import { ElementColumns, type TablePlan, ValueKeys } from "./plan";
import type { TableModel } from "./fields";
import { type Compiled, QualifiedColumn } from "./sql";
import { SortTerms } from "./json";
import {
  AliasedColumns,
  ColumnRowSource,
  type IndexedValue,
  JsonRowSource,
  LoggedColumns,
  NamedField,
  type RowSource,
} from "./row-source";
import { ExternalRowSource } from "./external-row-source";

/** The single column a value-mode relation projects, and the key its rows are decoded from. */
export const OUTPUT_COLUMN = "value";

type IndexResolver = (name: string) => string[];
type ScanNotice = (name: string) => void;

/**
 * What the relation still knows about the table it reads.
 *
 * Present only while the pipeline is row-shaped, its rows the table's rows whether read as columns
 * or as the documents a walk reads back: a stage that reshapes the output drops it, and its
 * absence is what makes a later write illegal rather than a flag somebody has to check.
 */
export interface TableOrigin {
  schemaId: string;
  tableId: string;
  model: TableModel;
  /** The table's physical layout: its name, key columns and indexes. */
  plan: TablePlan;
  index: IndexResolver;
  /** Told when a `CROSS_INSTANCE` read scans by an index name; absent where nobody is listening. */
  crossInstanceScan?: ScanNotice;
}

export interface OrderTerm {
  sql: Sql;
  descending: boolean;
}

/**
 * What a single-row relation answers with when it read no row: `null` everywhere but `get`, which
 * the contract asserts answers `undefined` for a row that is not there.
 */
type AbsentValue = null | undefined;

/**
 * An unrendered `SELECT`, and the accumulator the pipeline folds over.
 *
 * `from` is already-rendered FROM text — a table, a parenthesised subselect or a union — so the
 * three cases share one spelling, with `alias` always emitted. `projection` discriminates the two
 * output modes: absent selects the physical columns and decodes rows, present selects one
 * {@link OUTPUT_COLUMN} and decodes values.
 *
 * `crossInstance` is the root's instance scope reduced to the one fact a stage can act on: whether
 * `_id` alone still names one row.
 *
 * `limit` and `offset` are row counts known when the statement is compiled: the engine takes only
 * a constant or a bound value there.
 */
export interface Relation {
  dialect: Dialect;
  from: Sql;
  alias: string;
  /** The join clauses, already rendered, in the order they follow the `FROM`. */
  joins: Sql[];
  /** The conjuncts of the `WHERE`, each already parenthesised by whoever pushed it. */
  where: Sql[];
  groupBy: Compiled[];
  orderBy: OrderTerm[];
  limit?: number;
  offset?: number;
  distinct: boolean;
  single: boolean;
  absent: AbsentValue;
  aggregated: boolean;
  crossInstance: boolean;
  /**
   * Whether this block locks the rows it reads exclusively, as the read a write targets does. Only
   * the block that reads the table carries it: a wrap starts a fresh block over a derived table,
   * which has no rows to lock.
   */
  locked: boolean;
  source: RowSource;
  projection?: Compiled;
  origin?: TableOrigin;
  /** The source a plain projection renamed — see {@link SetPlainProjection}. */
  projectedFrom?: RowSource;
}

type RelationSeed = Pick<
  Relation,
  "dialect" | "from" | "alias" | "source" | "projection" | "origin"
>;

function NewRelation(seed: RelationSeed): Relation {
  return {
    ...seed,
    joins: [],
    where: [],
    groupBy: [],
    orderBy: [],
    distinct: false,
    single: false,
    absent: null,
    aggregated: false,
    crossInstance: false,
    locked: false,
  };
}

/** The table a row-mode relation reads, for the select list and the decoder that pair with it. */
export function RequireOrigin(relation: Relation): TableOrigin {
  const origin = relation.origin;
  assert(origin, "A row-mode relation must carry the origin of its table");
  return origin;
}

/** One named part of what an index name addresses. */
export interface IndexedMember extends IndexedValue {
  name: string;
}

/**
 * What an index name addresses, part by part, in the order the index declares its fields.
 *
 * A declared index on a relation that reads its table is read through the index's own key parts,
 * so a comparison names the key column its index is built on and a sort orders by it. Anything
 * else — a name that is not an index, or a relation that no longer knows its table — reads each
 * field as a {@link NamedField}, which is what keeps `map(…).orderBy("age")` working and sorts
 * `orderBy("title.fr")` by the nested value.
 */
export function IndexColumns(
  relation: Relation,
  name: string,
): IndexedMember[] {
  const origin = relation.origin;
  const planned = origin?.plan.indexes.find(
    (index) => index.id === name && index.parts[0]?.kind === "instance",
  );
  const source = relation.source;
  if (planned && source instanceof ColumnRowSource) {
    return planned.parts.flatMap((part) =>
      part.kind === "instance"
        ? []
        : [{ name: part.field, ...source.indexed(part) }],
    );
  }
  const fields = origin ? origin.index(name) : [name];
  return fields.map((field) => {
    const value = NamedField(relation.dialect, source, field);
    return { name: field, value, order: SortTerms(relation.dialect, value) };
  });
}

/**
 * {@link IndexColumns} for the stages that scan by the index — `getAll`, `between` and `orderBy` —
 * which is what a table's origin hears about when the read spans every instance.
 */
export function ScanColumns(relation: Relation, name: string): IndexedMember[] {
  if (relation.crossInstance) {
    relation.origin?.crossInstanceScan?.(name);
  }
  return IndexColumns(relation, name);
}

/**
 * Where a row-mode relation reads its columns: the table itself, whose key columns it can name, or
 * a subselect over it, which selected the stored columns only.
 */
export type TableReads = "table" | "output";

/** A row-mode relation over a table, or over a subselect that selected one's rows. */
export function TableRelation(
  dialect: Dialect,
  from: Sql,
  alias: string,
  origin: TableOrigin,
  reads: TableReads = "table",
): Relation {
  return NewRelation({
    dialect,
    from,
    alias,
    source: TableSource(dialect, alias, origin, reads),
    origin,
  });
}

/**
 * The row source of a table relation. An external relation's subselect holds every value under
 * its field name rather than the native column a table read converts, so `reads` tells the two
 * apart; a table the adapter owns keeps its physical names through a subselect but not its key
 * columns.
 */
function TableSource(
  dialect: Dialect,
  alias: string,
  origin: TableOrigin,
  reads: TableReads,
): RowSource {
  if (origin.model.external) {
    return new ExternalRowSource(dialect, alias, origin.model, reads);
  }
  const keys =
    reads === "table"
      ? {
          alias,
          columns: origin.plan.keyColumns,
          values: ValueKeys(origin.plan),
          elements: ElementColumns(origin.plan),
        }
      : undefined;
  return new ColumnRowSource(
    dialect,
    AliasedColumns(alias),
    origin.model,
    keys,
  );
}

/**
 * A row-mode relation over one logged image, which `row` addresses: the side of a change event a
 * feed's stages are folded over. It reads no key column, since an image holds none.
 */
export function LoggedRelation(
  dialect: Dialect,
  from: Sql,
  alias: string,
  row: Sql,
  origin: TableOrigin,
): Relation {
  return NewRelation({
    dialect,
    from,
    alias,
    source: new ColumnRowSource(
      dialect,
      LoggedColumns(dialect, row, origin.model),
      origin.model,
    ),
    origin,
  });
}

/**
 * A value-mode relation over already-rendered FROM text whose single output column is
 * {@link OUTPUT_COLUMN} — what a wrapped projection and a union both produce.
 */
export function ValueRelation(
  dialect: Dialect,
  from: Sql,
  alias: string,
  type: SqlType,
): Relation {
  const projection: Compiled = {
    sql: QualifiedColumn(alias, OUTPUT_COLUMN),
    type,
  };
  return NewRelation({
    dialect,
    from,
    alias,
    source: new JsonRowSource(dialect, projection),
    projection,
  });
}

/**
 * Moves the relation into value mode, addressing the projection for every later stage. Does not
 * wrap: the caller has already called `Prepare`, which keeps the wrap decision in one place.
 */
export function SetProjection(relation: Relation, value: Compiled): Relation {
  relation.projection = value;
  relation.source = new JsonRowSource(relation.dialect, value);
  relation.origin = undefined;
  relation.projectedFrom = undefined;
  return relation;
}

/**
 * Projects, and keeps the source addressable: only for a projection that *renames* its members, so
 * that the columns underneath still answer for them.
 */
export function SetPlainProjection(
  relation: Relation,
  value: Compiled,
  source: RowSource,
): Relation {
  const projected = SetProjection(relation, value);
  projected.projectedFrom = source;
  return projected;
}

/** What the relation currently yields, materialized — the operand of a field-less stage. */
export function CurrentValue(relation: Relation): Compiled {
  return relation.projection ?? relation.source.toJson();
}
