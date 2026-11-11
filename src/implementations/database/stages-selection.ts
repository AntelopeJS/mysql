import assert from "node:assert";
import {
  IsQueryStage,
  type QueryStage,
  type QueryValue,
} from "@antelopejs/interface-database/common";

import { type Sql, join, sql } from "../../statement";
import { IsArray } from "./types";
import { StoredAs } from "./readings";
import { DecodeValue } from "./value";
import type { DecodingContext } from "./context";
import { type Compiled, QualifiedColumn } from "./sql";
import { Compare, EqualityKey, type Ordering } from "./json";
import { KeylessRefusal } from "./external-refusals";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import { ID_COLUMN, INSTANCE_COLUMN, OptionsOf } from "./utils";
import { FIRST_OPERAND, RequireOperand, SECOND_OPERAND } from "./stage";
import {
  type Relation,
  RequireOrigin,
  ScanColumns,
  type TableOrigin,
} from "./relation";
import { Prepare, SINGLE_ROW, WHERE_BLOCKERS } from "./render";
import { IsString } from "./guards";
import { ClassifyMember, IsList, StageOperand } from "./member";

const NO_KEYS = sql`FALSE`;
const COMMA = sql`, `;
const SINGLE_FIELD = 1;

/**
 * One selection stage mid-compilation: the columns its keys address, the stage and index name,
 * and the context. All are needed at the bottom of the key walk, so they travel as one value.
 */
interface KeySelection {
  relation: Relation;
  columns: Compiled[];
  indexId: string | undefined;
  stage: QueryStage;
  context: DecodingContext;
}

/**
 * Opens a selection stage the way `filter` opens, and resolves the columns its keys address.
 * An absent index name addresses `_id` directly rather than through the resolver.
 */
function Selected(
  relation: Relation,
  stage: QueryStage,
  context: DecodingContext,
  indexId: string | undefined,
): KeySelection {
  const prepared = Prepare(relation, WHERE_BLOCKERS, context);
  RequireKey(RequireOrigin(prepared), indexId);
  const columns =
    indexId === undefined
      ? [prepared.source.field(ID_COLUMN)]
      : ScanColumns(prepared, indexId).map((column) => column.value);
  return {
    relation: prepared,
    columns: columns.map(Addressed),
    indexId,
    stage,
    context,
  };
}

/** Refuses reading by `_id` a relation that has no key to alias, rather than matching nothing. */
function RequireKey(origin: TableOrigin, indexId: string | undefined): void {
  const external = origin.model.external;
  const byKey = indexId === undefined || indexId === ID_COLUMN;
  if (external && !external.key && byKey) {
    throw KeylessRefusal(external);
  }
}

/**
 * A key column as the stage compares it: the bare column of an external relation, so its index
 * serves the match, keeping the native operand that converts each key into its type.
 */
function Addressed(column: Compiled): Compiled {
  return column.native ? { ...column, sql: column.native.sql } : column;
}

function IndexOption(stage: QueryStage): string | undefined {
  const name: unknown = OptionsOf(stage)?.index;
  if (name === undefined || name === null) {
    return undefined;
  }
  assert(
    IsString(name),
    `The '${stage.stage}' stage names its index with a string`,
  );
  return name;
}

/**
 * Reads one caller-supplied key as the type of the column it addresses.
 * Only `undefined` is an absent operand; a `null` key is a value, and deliberately not an open bound.
 */
function KeyValue(
  selection: KeySelection,
  key: QueryValue,
  column: Compiled,
  index: number,
  operator: Ordering = "=",
): Compiled {
  const stored = StoredAs(
    selection.context.dialect,
    Decoded(selection, key, index),
    column.type,
  );
  return column.native
    ? { sql: column.native.bind(stored.sql, operator), type: stored.type }
    : stored;
}

function Decoded(
  selection: KeySelection,
  key: QueryValue,
  index: number,
): Compiled {
  return RequireOperand(
    DecodeValue(ClassifyMember(key), selection.context),
    selection.stage,
    index,
  );
}

/** An array at the top level is always a list of keys, which is what the varargs form means. */
function KeyList(argument: QueryValue): readonly QueryValue[] {
  return IsList(argument) ? argument : [argument];
}

/**
 * One key, taken whole against a single-field index and element-wise against a compound one.
 * A hole inside a tuple is named by the index and the position it is missing from.
 */
function KeyTuple(selection: KeySelection, key: QueryValue): Compiled[] {
  const columns = selection.columns;
  if (columns.length === SINGLE_FIELD) {
    return [KeyValue(selection, key, columns[0], FIRST_OPERAND)];
  }
  assert(
    IsList(key) && key.length === columns.length,
    `The '${selection.indexId}' index takes a key of ${columns.length} values, received ${IsList(key) ? `${key.length} values` : ClassifyMember(key).kind}`,
  );
  return key.map((part, position) => {
    assert(
      part !== undefined,
      `The '${selection.indexId}' index takes a value for every field, and has none at position ${position}`,
    );
    return KeyValue(selection, part, columns[position], FIRST_OPERAND);
  });
}

/**
 * Matches a key against a column holding a *list* of values, which is what `multi` declares, as a
 * disjunction of element tests an index over the elements serves.
 */
function Contained(selection: KeySelection, keys: readonly QueryValue[]): Sql {
  const column = selection.columns[0];
  assert(IsArray(column.type), "A contained key addresses a list column");
  const elem = column.type.elem;
  const dialect = selection.context.dialect;
  const tests = keys.map((key) => {
    const value = Decoded(selection, key, FIRST_OPERAND);
    const element = StoredAs(dialect, value, elem).sql;
    return dialect.sql.json.includes(column.sql, element);
  });
  return join(tests, sql` OR `);
}

/** Refuses an index that keys on an array field beside others, naming the index. */
function RequireAddressable(selection: KeySelection): void {
  assert(
    !selection.columns.some((column) => IsArray(column.type)),
    `The '${selection.indexId}' index keys on an array field beside others, which no key addresses`,
  );
}

function Row(parts: readonly Sql[]): Sql {
  return parts.length === SINGLE_FIELD
    ? parts[0]
    : sql`(${join(parts, COMMA)})`;
}

/**
 * The columns compared against a list of key tuples, and the tuples: through the key columns where
 * a part has one, so the index narrows the rows, and then through the values themselves, which
 * decide them.
 */
function InList(
  selection: KeySelection,
  tuples: readonly (readonly Compiled[])[],
): Sql {
  const dialect = selection.context.dialect;
  const columns = selection.columns;
  const plain = sql`${Row(columns.map((column) => column.sql))} IN (${join(
    tuples.map((tuple) => Row(tuple.map((value) => value.sql))),
    COMMA,
  )})`;
  if (!columns.some((column) => column.key)) {
    return plain;
  }
  const keyed = tuples.map((tuple) =>
    tuple.map(
      (value, position) =>
        EqualityKey(dialect, columns[position], value.sql) ?? {
          column: columns[position].sql,
          bound: value.sql,
        },
    ),
  );
  const keyColumns = Row(keyed[0].map((part) => part.column));
  const bounds = keyed.map((tuple) => Row(tuple.map((part) => part.bound)));
  return sql`${keyColumns} IN (${join(bounds, COMMA)}) AND ${plain}`;
}

/**
 * Matches a key list against one column, or a list of key tuples against a row of them.
 * An empty list is `FALSE`; a column declared as an array takes {@link Contained} instead.
 */
function KeySet(selection: KeySelection, keys: readonly QueryValue[]): Sql {
  if (keys.length === 0) {
    return NO_KEYS;
  }
  const columns = selection.columns;
  if (columns.length === SINGLE_FIELD && IsArray(columns[0].type)) {
    return Contained(selection, keys);
  }
  RequireAddressable(selection);
  return InList(
    selection,
    keys.map((key) => KeyTuple(selection, key)),
  );
}

/**
 * Makes a key that names many rows name one of them, which only `CROSS_INSTANCE` can produce.
 * Ordered by `_instance` so a read and a delete agree on which row, and emitted only under it.
 */
function BoundToOneInstance(relation: Relation): void {
  if (!relation.crossInstance) {
    return;
  }
  relation.orderBy.push({
    sql: QualifiedColumn(relation.alias, INSTANCE_COLUMN),
    descending: false,
  });
  relation.limit = SINGLE_ROW;
}

/**
 * The one relation that answers `undefined` rather than `null` for a row that is not there.
 * No index name is read off the stage: `get` addresses the primary key by definition.
 */
const GetStage: PipelineStage = (relation, stage, context) => {
  assert(IsQueryStage(stage, "get"), "The 'get' stage reads a 'get' stage");
  const selection = Selected(relation, stage, context, undefined);
  const prepared = selection.relation;
  const column = selection.columns[0];
  const key = KeyValue(
    selection,
    StageOperand(stage, FIRST_OPERAND),
    column,
    FIRST_OPERAND,
  );
  prepared.where.push(Compare(context.dialect, column, key, "="));
  prepared.single = true;
  prepared.absent = undefined;
  BoundToOneInstance(prepared);
  return prepared;
};

/** Naming no index selects on the primary key, which is the contract's own default. */
const GetAllStage: PipelineStage = (relation, stage, context) => {
  assert(
    IsQueryStage(stage, "getAll"),
    "The 'getAll' stage reads a 'getAll' stage",
  );
  const selection = Selected(relation, stage, context, IndexOption(stage));
  const keys = KeyList(StageOperand(stage, FIRST_OPERAND));
  selection.relation.where.push(sql`(${KeySet(selection, keys)})`);
  return selection.relation;
};

/**
 * Restricts the relation to a half-open range over one field, low inclusive and high exclusive.
 * A compound index and an array field are both refused by name, having no reading to offer.
 */
const BetweenStage: PipelineStage = (relation, stage, context) => {
  assert(
    IsQueryStage(stage, "between"),
    "The 'between' stage reads a 'between' stage",
  );
  const name = IndexOption(stage);
  assert(name !== undefined, "The 'between' stage is missing its field name");
  const selection = Selected(relation, stage, context, name);
  const columns = selection.columns;
  assert(
    columns.length === SINGLE_FIELD,
    `The 'between' stage ranges over one field, but '${name}' names ${columns.length}`,
  );
  const column = columns[0];
  assert(
    !IsArray(column.type),
    `The 'between' stage ranges over one value, but '${name}' holds a list`,
  );
  const low = KeyValue(
    selection,
    StageOperand(stage, FIRST_OPERAND),
    column,
    FIRST_OPERAND,
    ">=",
  );
  const high = KeyValue(
    selection,
    StageOperand(stage, SECOND_OPERAND),
    column,
    SECOND_OPERAND,
    "<",
  );
  selection.relation.where.push(
    Compare(context.dialect, column, low, ">="),
    Compare(context.dialect, column, high, "<"),
  );
  return selection.relation;
};

/**
 * The stages that pick rows by key, each absorbing one predicate exactly as `filter` does. A field
 * declared as an array is where they part company: `getAll` matches it by containment, which is
 * the reading a `multi` index is created for, and `between` refuses it.
 */
export const SELECTION_STAGES: PipelineStageMap = {
  get: GetStage,
  getAll: GetAllStage,
  between: BetweenStage,
};
