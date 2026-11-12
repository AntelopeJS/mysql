import assert from "node:assert";
import {
  IsQueryStage,
  type QueryStage,
  type QueryValue,
} from "@antelopejs/interface-database/common";

import { Bind, type Sql, join, sql } from "../../statement";
import { IsArray, IsJsonBacked } from "./types";
import { StoredAs } from "./readings";
import { DecodeValue } from "./value";
import type { DecodingContext } from "./context";
import {
  type Compiled,
  type Equality,
  QualifiedColumn,
  type ValueReference,
} from "./sql";
import {
  Compare,
  Compared,
  Contains,
  EqualityKey,
  type Ordering,
} from "./json";
import {
  type RankedKey,
  RankedEqualities,
  RankedKeyOf,
  RankedRange,
} from "./ranked-key";
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
import { SINGLE_ROW, WHERE_BLOCKERS } from "./render";
import { Prepare } from "./wrap";
import { IsString } from "./guards";
import { ClassifyMember, IsList, StageOperand } from "./member";

const NO_KEYS = sql`FALSE`;
const COMMA = sql`, `;
const SINGLE_FIELD = 1;

/**
 * One part of what a selection stage's keys address: the value a key is compared with, and the
 * value key that narrows the rows where the part is a value of no declared type.
 */
interface SelectedPart {
  readonly value: Compiled;
  readonly ranked?: ValueReference;
}

/**
 * One selection stage mid-compilation: the parts its keys address, the stage and index name, and
 * the context. All are needed at the bottom of the key walk, so they travel as one value.
 */
interface KeySelection {
  relation: Relation;
  parts: SelectedPart[];
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
  const parts: SelectedPart[] =
    indexId === undefined
      ? [{ value: prepared.source.field(ID_COLUMN) }]
      : ScanColumns(prepared, indexId);
  return {
    relation: prepared,
    parts: parts.map(({ value, ranked }) => ({
      value: Addressed(value),
      ranked,
    })),
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
 * One caller-supplied key as a part compares it: read as the type of the value the part holds, which
 * decides the rows, and as the part's value key holds it, which narrows them.
 */
interface KeyOperand {
  readonly compared: Compiled;
  readonly ranked?: RankedKey;
}

/**
 * Reads one caller-supplied key as the part it addresses compares it.
 * Only `undefined` is an absent operand; a `null` key is a value, and deliberately not an open bound.
 */
function KeyValue(
  selection: KeySelection,
  key: QueryValue,
  part: SelectedPart,
  index: number,
  operator: Ordering = "=",
): KeyOperand {
  const dialect = selection.context.dialect;
  const decoded = Decoded(selection, key, index);
  const column = part.value;
  const stored = StoredAs(dialect, decoded, column.type);
  const compared = column.native
    ? { sql: column.native.bind(stored.sql, operator), type: stored.type }
    : stored;
  const ranked = part.ranked && RankedKeyOf(dialect, part.ranked, decoded);
  return { compared, ranked };
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
function KeyTuple(selection: KeySelection, key: QueryValue): KeyOperand[] {
  const parts = selection.parts;
  if (parts.length === SINGLE_FIELD) {
    return [KeyValue(selection, key, parts[0], FIRST_OPERAND)];
  }
  assert(
    IsList(key) && key.length === parts.length,
    `The '${selection.indexId}' index takes a key of ${parts.length} values, received ${IsList(key) ? `${key.length} values` : ClassifyMember(key).kind}`,
  );
  return key.map((value, position) => {
    assert(
      value !== undefined,
      `The '${selection.indexId}' index takes a value for every field, and has none at position ${position}`,
    );
    return KeyValue(selection, value, parts[position], FIRST_OPERAND);
  });
}

/**
 * Matches a key against a column holding a *list* of values, which is what `multi` declares, as a
 * disjunction of element tests an index over the elements serves.
 */
function Contained(selection: KeySelection, keys: readonly QueryValue[]): Sql {
  const column = selection.parts[0].value;
  assert(IsArray(column.type), "A contained key addresses a list column");
  const elem = column.type.elem;
  const dialect = selection.context.dialect;
  const tests = keys.map((key) => {
    const value = Decoded(selection, key, FIRST_OPERAND);
    const element = StoredAs(dialect, value, elem).sql;
    return Contains(dialect, column, element);
  });
  return join(tests, sql` OR `);
}

/** Refuses an index that keys on an array field beside others, naming the index. */
function RequireAddressable(selection: KeySelection): void {
  assert(
    !selection.parts.some((part) => IsArray(part.value.type)),
    `The '${selection.indexId}' index keys on an array field beside others, which no key addresses`,
  );
}

function Row(parts: readonly Sql[]): Sql {
  return parts.length === SINGLE_FIELD
    ? parts[0]
    : sql`(${join(parts, COMMA)})`;
}

/**
 * The equalities that hold on every row a key tuple names: through a typed key column, through a
 * value key's columns for the key's kind, or through the value itself where no index keys the part.
 * A value key cannot narrow a key whose kind only the statement knows, and leaves it out.
 */
function TupleEqualities(
  selection: KeySelection,
  tuple: readonly KeyOperand[],
): Equality[] {
  const dialect = selection.context.dialect;
  return tuple.flatMap((operand, position) => {
    const part = selection.parts[position];
    if (part.ranked) {
      return (operand.ranked && RankedEqualities(operand.ranked)) ?? [];
    }
    const value = operand.compared.sql;
    return (
      EqualityKey(dialect, part.value, value) ?? [
        { column: part.value.sql, value },
      ]
    );
  });
}

/**
 * The tuples whose equalities name the same columns, as a row of those columns in a list of rows:
 * the form an index serves as one lookup per tuple. Keys of different kinds name different columns
 * of a value key, so a list of them is one such test per kind.
 */
function EqualitySets(bounds: readonly (readonly Equality[])[]): Sql {
  const byColumns = new Map<string, (readonly Equality[])[]>();
  for (const bound of bounds) {
    const columns = Bind(Row(bound.map((equality) => equality.column))).sql;
    byColumns.set(columns, [...(byColumns.get(columns) ?? []), bound]);
  }
  const sets = [...byColumns.values()].map((group) => {
    const columns = Row(group[0].map((equality) => equality.column));
    const rows = group.map((bound) =>
      Row(bound.map((equality) => equality.value)),
    );
    return sql`${columns} IN (${join(rows, COMMA)})`;
  });
  return sets.length === SINGLE_FIELD
    ? sets[0]
    : sql`(${join(sets, sql` OR `)})`;
}

/**
 * The rows whose parts equal one of the tuples. A list over JSON values is a disjunction of
 * equalities, each as JSON compares, since `IN` compares them as the engine compares any value.
 */
function Matching(
  selection: KeySelection,
  tuples: readonly (readonly KeyOperand[])[],
): Sql {
  const parts = selection.parts;
  if (!parts.some((part) => IsJsonBacked(part.value.type))) {
    return sql`${Row(parts.map((part) => part.value.sql))} IN (${join(
      tuples.map((tuple) => Row(tuple.map((operand) => operand.compared.sql))),
      COMMA,
    )})`;
  }
  const dialect = selection.context.dialect;
  const matches = tuples.map((tuple) => {
    const equalities = tuple.map((operand, position) =>
      Compared(dialect, parts[position].value, operand.compared, "="),
    );
    return sql`(${join(equalities, sql` AND `)})`;
  });
  return sql`(${join(matches, sql` OR `)})`;
}

/**
 * The parts compared against a list of key tuples, and the tuples: through the key columns where a
 * part has them, so the index narrows the rows, and then through the values themselves, which
 * decide them.
 */
function InList(
  selection: KeySelection,
  tuples: readonly (readonly KeyOperand[])[],
): Sql {
  const parts = selection.parts;
  const plain = Matching(selection, tuples);
  if (!parts.some((part) => part.value.key || part.ranked)) {
    return plain;
  }
  const bounds = tuples.map((tuple) => TupleEqualities(selection, tuple));
  if (bounds.some((bound) => bound.length === 0)) {
    return plain;
  }
  return sql`${EqualitySets(bounds)} AND ${plain}`;
}

/**
 * Matches a key list against one column, or a list of key tuples against a row of them.
 * An empty list is `FALSE`; a column declared as an array takes {@link Contained} instead.
 */
function KeySet(selection: KeySelection, keys: readonly QueryValue[]): Sql {
  if (keys.length === 0) {
    return NO_KEYS;
  }
  const parts = selection.parts;
  if (parts.length === SINGLE_FIELD && IsArray(parts[0].value.type)) {
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
  const part = selection.parts[0];
  const key = KeyValue(
    selection,
    StageOperand(stage, FIRST_OPERAND),
    part,
    FIRST_OPERAND,
  );
  prepared.where.push(Compare(context.dialect, part.value, key.compared, "="));
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
 * A compound index and an array field are both refused by name, having no reading to offer. Over a
 * value of no declared type the bounds compare as JSON values, as without the index, and the
 * value key narrows the rows to the kinds and values between them.
 */
const BetweenStage: PipelineStage = (relation, stage, context) => {
  assert(
    IsQueryStage(stage, "between"),
    "The 'between' stage reads a 'between' stage",
  );
  const name = IndexOption(stage);
  assert(name !== undefined, "The 'between' stage is missing its field name");
  const selection = Selected(relation, stage, context, name);
  const parts = selection.parts;
  assert(
    parts.length === SINGLE_FIELD,
    `The 'between' stage ranges over one field, but '${name}' names ${parts.length}`,
  );
  const part = parts[0];
  assert(
    !IsArray(part.value.type),
    `The 'between' stage ranges over one value, but '${name}' holds a list`,
  );
  const low = KeyValue(
    selection,
    StageOperand(stage, FIRST_OPERAND),
    part,
    FIRST_OPERAND,
    ">=",
  );
  const high = KeyValue(
    selection,
    StageOperand(stage, SECOND_OPERAND),
    part,
    SECOND_OPERAND,
    "<",
  );
  const where = selection.relation.where;
  const present = part.value.native?.present;
  if (present) {
    where.push(present);
  }
  if (part.ranked && low.ranked && high.ranked) {
    where.push(
      RankedRange(context.dialect, part.ranked, low.ranked, high.ranked),
    );
  }
  where.push(
    Compare(context.dialect, part.value, low.compared, ">="),
    Compare(context.dialect, part.value, high.compared, "<"),
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
