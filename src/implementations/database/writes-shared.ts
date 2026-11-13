import assert from "node:assert";
import type { QueryStage } from "@antelopejs/interface-database/common";
import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";

import type { Dialect } from "../../dialect";
import { type Sql, ident, sql } from "../../statement";
import type { DecodingContext } from "./context";
import { EXTRA_COLUMN } from "./utils";
import type { InstanceScope, RootSelection } from "./selection";
import { type Compiled, QualifiedColumn } from "./sql";
import { type Relation, RequireOrigin, type TableOrigin } from "./relation";
import { AliasedColumns, ColumnRowSource, type RowSource } from "./row-source";
import type { OverflowMembers } from "./payload";
import { FIRST_OPERAND } from "./stage";
import {
  ClassifyMember,
  type DocumentView,
  IsList,
  StageOperand,
} from "./member";

/**
 * The rows a write changes, and everything it may know about them.
 *
 * `relation` is the read pipeline the write targets, joined as a derived table by the stages that
 * reshape existing rows; `insert` has no rows to target and requires the relation to be untouched
 * instead. `instance` is carried straight off {@link RootSelection}.
 */
export interface WriteTarget {
  relation: Relation;
  origin: TableOrigin;
  instance: InstanceScope;
}

/** The rows a query's terminal write targets, assembled the one way. */
export function WriteTargetOf(
  root: RootSelection,
  relation: Relation,
): WriteTarget {
  return {
    relation,
    origin: RequireOrigin(relation),
    instance: root.instance,
  };
}

/**
 * What a write compiles to, and the answer it owes.
 *
 * - `count`: one statement, run as a transaction that a deadlock or a lock wait runs again, answered
 *   by the rows it matched.
 * - `insert`: statements run in one transaction, answered by the keys known before they run, in
 *   input order. None at all is an insert of no documents.
 * - `upsert`: a transaction that reads which of `ids` exist with `lock`, holding them, and then
 *   runs what `write` builds from that answer; answered by `ids`.
 * - `atomic`: one statement whose match count is the mutation's outcome.
 *
 * `sets` names the physical columns the write stores a value in: every column for a write that may
 * add rows, the assigned ones for a write that changes rows, none for a delete.
 */
export type WriteStatement = WriteExecution & {
  readonly sets: readonly string[];
};

type WriteExecution =
  | { readonly kind: "count"; readonly statement: Sql }
  | {
      readonly kind: "insert";
      readonly ids: string[];
      readonly statements: readonly Sql[];
    }
  | {
      readonly kind: "upsert";
      readonly ids: string[];
      readonly lock: Sql;
      readonly write: (existing: ReadonlySet<string>) => Sql[];
    }
  | { readonly kind: "atomic"; readonly statement: Sql };

/** One terminal stage's compiler, which a write family module implements and `writes.ts` dispatches. */
export type WriteCompiler = (
  target: WriteTarget,
  stage: QueryStage,
  context: DecodingContext,
) => WriteStatement;

/**
 * The alias a write statement gives the table it targets. It must stay disjoint from the aliases
 * the context hands out, so the derived table of the read can be addressed beside it: an inner
 * alias equal to this one would compare every row against itself.
 */
export const WRITE_ALIAS = "w0";

/** The table a write targets, under the alias the rest of its statement refers to it by. */
export function WriteTable(origin: TableOrigin): Sql {
  return sql`${ident(origin.plan.table)} AS ${ident(WRITE_ALIAS)}`;
}

/**
 * The row the values a write computes read: the targeted row as the derived table of the read
 * holds it, at `alias`. The derived table is materialized before any row is changed, so every value
 * reads the row as it was before the statement, whatever order the assignments run in.
 */
export function WriteRowSource(
  dialect: Dialect,
  origin: TableOrigin,
  alias: string,
): RowSource {
  return new ColumnRowSource(dialect, AliasedColumns(alias), origin.model);
}

/** One column a write assigns, beside the value it assigns to it. */
export interface WrittenColumn {
  column: string;
  value: Sql;
}

/** One `SET` assignment, to a column of the targeted row; the column is already the physical one. */
export function Assignment(column: string, value: Sql): Sql {
  return sql`${QualifiedColumn(WRITE_ALIAS, column)} = ${value}`;
}

/** The targeted row's own overflow document, read back as an object rather than as NULL. */
export function ExistingExtra(dialect: Dialect): Sql {
  return sql`COALESCE(${QualifiedColumn(WRITE_ALIAS, EXTRA_COLUMN)}, ${dialect.sql.json.emptyObject})`;
}

/**
 * The overflow document a merging write leaves behind: the row's own, with each written key set.
 * `update` and an upsert's `update` mode are the same instruction reached two ways.
 */
export function MergeExtra(
  dialect: Dialect,
  incoming: OverflowMembers | undefined,
): Sql {
  const entries = (incoming?.entries ?? []).map(
    ([name, value]): [string, Sql] => [name, value.sql],
  );
  return dialect.sql.json.setKeys(ExistingExtra(dialect), entries);
}

/**
 * The documents one `insert` stage writes, whether the caller passed one or a batch. An array is
 * the batch and never a document; the refusal names the position.
 */
export function InsertedDocuments(stage: QueryStage): DocumentView[] {
  const argument = StageOperand(stage, FIRST_OPERAND);
  const list = IsList(argument) ? argument : [argument];
  return list.map((entry, position) => {
    const { document, kind } = ClassifyMember(entry);
    assert(
      document,
      `The '${stage.stage}' stage takes documents, received ${kind} at position ${position}`,
    );
    return document;
  });
}

/**
 * The instance fragment the query root bound, for the writes that need one named. `CROSS_INSTANCE`
 * is the *absence* of an instance predicate, which a write stating a whole row has no answer for.
 */
export function RequireInstance(
  target: WriteTarget,
  stage: QueryStage,
): Compiled {
  const scope = target.instance;
  assert(
    scope !== CROSS_INSTANCE,
    `The '${stage.stage}' stage cannot write under CROSS_INSTANCE: name the instance the rows belong to, or omit the instance id for the default one`,
  );
  return scope;
}
