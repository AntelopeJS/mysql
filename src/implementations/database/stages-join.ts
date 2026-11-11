import assert from "node:assert";
import { Query } from "@antelopejs/interface-database";
import type { QueryStage } from "@antelopejs/interface-database/common";

import type { Dialect } from "../../dialect";
import { type Sql, ident, sql } from "../../statement";
import { Compare, Collected } from "./json";
import { UnifyOperands } from "./coerce";
import { DecodeFunction, RecordedLambda } from "./value";
import { AsJson, Predicate } from "./readings";
import type { DecodingContext } from "./context";
import { JsonRowSource, type RowSource } from "./row-source";
import type { PipelineStage, PipelineStageMap } from "./pipeline";
import { FIRST_OPERAND, RequireOperand, SECOND_OPERAND } from "./stage";
import { type Compiled, QualifiedColumn } from "./sql";
import {
  ArrayOf,
  IsArray,
  IsOpaque,
  JsonOf,
  KeyTypesOf,
  type KeyTypes,
  OPAQUE,
  type SqlType,
} from "./types";
import {
  CurrentValue,
  OUTPUT_COLUMN,
  type Relation,
  SetProjection,
} from "./relation";
import {
  HasFlag,
  type JoinKind,
  JoinOn,
  Nested,
  Prepare,
  type RelationFlag,
  Render,
  SINGLE_ROW,
  WHERE_BLOCKERS,
} from "./render";
import { IsString } from "./guards";
import { ID_COLUMN, OptionsOf } from "./utils";

const MAPPER_OPERAND = 2;

/**
 * Everything that has already decided *which rows* there are blocks a join, which changes their
 * count. `ordered` does not: the order is kept, and wrapping would only lose it.
 */
const JOIN_BLOCKERS: readonly RelationFlag[] = [
  "projection",
  "limit",
  "offset",
  "distinct",
  "aggregated",
];

/** What one of the two joins is: `nullable` says whether the mapper's right row can be missing. */
interface JoinFlavour {
  kind: JoinKind;
  nullable: boolean;
}

const INNER_FLAVOUR: JoinFlavour = { kind: "JOIN", nullable: false };
const OUTER_FLAVOUR: JoinFlavour = { kind: "LEFT JOIN", nullable: true };

function FlavourOf(stage: QueryStage): JoinFlavour {
  return OptionsOf(stage)?.innerOnly === true ? INNER_FLAVOUR : OUTER_FLAVOUR;
}

/** Compiles the query being joined, from its own root, as a FROM item at a fresh alias. */
function JoinedRelation(stage: QueryStage, context: DecodingContext): Relation {
  const right: unknown = stage.args[FIRST_OPERAND];
  assert(
    right instanceof Query,
    "The 'join' stage takes another query to join against",
  );
  return Nested(context.relation(right.build()), context);
}

/** Binds both lambda parameters to the two row sources, which leaves the condition two columns. */
function Condition(
  stage: QueryStage,
  sources: RowSource[],
  context: DecodingContext,
): Sql {
  const body = DecodeFunction(
    RecordedLambda(stage, SECOND_OPERAND),
    context,
    sources,
  );
  const matched = RequireOperand(body, stage, SECOND_OPERAND);
  return sql`(${Predicate(context.dialect, matched).sql})`;
}

/**
 * A row whose *document* is SQL NULL when the row is missing, which is what a missed `LEFT JOIN`
 * row reads as: a field of one is already SQL NULL, where the document over its columns would be
 * `{}`. `_id`, never NULL on a row that is there, is the test.
 */
class NullableRowSource implements RowSource {
  public constructor(private readonly inner: RowSource) {}

  public field(name: string, def?: Compiled): Compiled {
    return this.inner.field(name, def);
  }

  public dynamicField(key: Compiled, def?: Compiled): Compiled {
    return this.inner.dynamicField(key, def);
  }

  public toJson(): Compiled {
    const document = this.inner.toJson();
    const present = this.inner.field(ID_COLUMN).sql;
    return {
      sql: sql`(CASE WHEN ${present} IS NOT NULL THEN ${document.sql} END)`,
      type: document.type,
    };
  }

  public keyTypes(): KeyTypes | undefined {
    return this.inner.keyTypes();
  }
}

/**
 * The source the mapper reads the right row through, wrapped only where a missed row is possible.
 * A value-mode right needs no wrapper: its projected column is SQL NULL on a miss.
 */
function MapperSource(right: Relation, flavour: JoinFlavour): RowSource {
  if (!flavour.nullable || !right.origin) {
    return right.source;
  }
  return new NullableRowSource(right.source);
}

/** Brings a second query into the pipeline as a `JOIN`, with the mapper's result as the projection. */
const JoinStage: PipelineStage = (relation, stage, context) => {
  const flavour = FlavourOf(stage);
  const prepared = Prepare(relation, JOIN_BLOCKERS, context);
  const right = JoinedRelation(stage, context);
  const on = Condition(stage, [prepared.source, right.source], context);
  prepared.joins.push(JoinOn(flavour.kind, right.from, right.alias, on));
  const mapped = DecodeFunction(
    RecordedLambda(stage, MAPPER_OPERAND),
    context,
    [prepared.source, MapperSource(right, flavour)],
  );
  return SetProjection(prepared, RequireOperand(mapped, stage, MAPPER_OPERAND));
};

/**
 * What has already reshaped the rows blocks a lookup, and a row bound does not: the looked-up
 * subselect answers at most one row per row, so it changes no row count.
 */
const LOOKUP_BLOCKERS: readonly RelationFlag[] = [
  "projection",
  "distinct",
  "aggregated",
];

interface LookupKeys {
  localKey: string;
  otherKey: string;
}

function KeysOf(stage: QueryStage): LookupKeys {
  const localKey: unknown = OptionsOf(stage)?.localKey;
  const otherKey: unknown = OptionsOf(stage)?.otherKey;
  assert(
    IsString(localKey) && IsString(otherKey),
    "The 'lookup' stage names the local key and the other key with strings",
  );
  return { localKey, otherKey };
}

type Correlation = (dialect: Dialect, other: Compiled, local: Compiled) => Sql;
type Subselect = (right: Relation, context: DecodingContext) => Sql;

/**
 * The two shapes a lookup takes, chosen from the *declared* type of the local key: one row for a
 * scalar, every matching row for a list.
 */
interface LookupForm {
  correlate: Correlation;
  subselect: Subselect;
  replaced: (value: SqlType) => SqlType;
}

/** Bounds the subselect to one row, so a lookup never multiplies the rows it was given. */
function OneRow(right: Relation): Sql {
  right.limit = SINGLE_ROW;
  return Render(right);
}

/** Collects every matching row into one JSON array, empty rather than NULL over none of them. */
function CollectedRows(right: Relation, context: DecodingContext): Sql {
  const alias = context.nextAlias();
  const element = AsJson(context.dialect, {
    sql: QualifiedColumn(alias, OUTPUT_COLUMN),
    type: CurrentValue(right).type,
  });
  const collected = Collected(context.dialect, undefined, element.sql);
  return sql`SELECT ${collected} AS ${ident(OUTPUT_COLUMN)} FROM (${Render(right)}) AS ${ident(alias)}`;
}

const SINGLE_FORM: LookupForm = {
  correlate: (dialect, other, local) => Compare(dialect, other, local, "="),
  subselect: OneRow,
  replaced: (value) => value,
};

const COLLECTED_FORM: LookupForm = {
  correlate: (dialect, other, local) =>
    dialect.sql.json.includes(local.sql, other.sql),
  subselect: CollectedRows,
  replaced: ArrayOf,
};

function FormOf(local: Compiled, key: string): LookupForm {
  assert(
    !IsOpaque(local.type),
    `The 'lookup' stage takes its form from the local key's declared type, and '${key}' has none;` +
      " declare it on the table, as an array to look up a list and as anything else for one row",
  );
  return IsArray(local.type) ? COLLECTED_FORM : SINGLE_FORM;
}

/** Compiles the query the key points at, from its own root, to take one more predicate. */
function LookedUp(stage: QueryStage, context: DecodingContext): Relation {
  const other: unknown = stage.args[FIRST_OPERAND];
  assert(
    other instanceof Query,
    "The 'lookup' stage takes another query to read the key from",
  );
  return context.relation(other.build());
}

/**
 * {@link WHERE_BLOCKERS} without the projection, which a plain one survives: its columns are still
 * addressable, and the correlation is tested before the projection applies.
 */
const PUSHDOWN_BLOCKERS: readonly RelationFlag[] = WHERE_BLOCKERS.filter(
  (flag) => flag !== "projection",
);

const PATH_SEPARATOR = ".";

/**
 * Reads the other key as an index field is read: a member by its exact name where the row declares
 * one, and otherwise a dotted name as a path below its first segment. So the correlation reaches
 * the key column an index over `title.fr` holds, and that index serves the lookup.
 */
function OtherKey(source: RowSource, key: string, dialect: Dialect): Compiled {
  const [head, ...rest] = key.split(PATH_SEPARATOR);
  const declared = source.keyTypes();
  if (rest.length === 0 || (declared && Object.hasOwn(declared, key))) {
    return source.field(key);
  }
  return rest.reduce(
    (value, segment) => new JsonRowSource(dialect, value).field(segment),
    source.field(head),
  );
}

/**
 * Pushes the correlation onto the looked-up relation. A scalar key against a list on the other
 * side matches a row whose list holds it.
 */
function Correlate(
  right: Relation,
  source: RowSource,
  keys: LookupKeys,
  local: Compiled,
  form: LookupForm,
): void {
  const dialect = right.dialect;
  const other = OtherKey(source, keys.otherKey, dialect);
  if (IsArray(other.type) && !IsArray(local.type)) {
    const element = AsJson(dialect, local).sql;
    right.where.push(dialect.sql.json.includes(other.sql, element));
    return;
  }
  const unified = UnifyOperands(dialect, other, local);
  right.where.push(form.correlate(dialect, unified.left, unified.right));
}

/**
 * The source {@link Correlate} may push onto below a plain projection, so the other key stays a
 * column of the table; nothing where it has to sit above it.
 */
function Correlatable(right: Relation): RowSource | undefined {
  return HasFlag(right, PUSHDOWN_BLOCKERS) ? undefined : right.projectedFrom;
}

/** The document a lookup's local key reads into: the left one's members, the key replaced. */
function ReplacedType(document: SqlType, key: string, value: SqlType): SqlType {
  const keyTypes = KeyTypesOf(document);
  return keyTypes ? JsonOf({ ...keyTypes, [key]: value }) : OPAQUE;
}

/** The left document with one key set to what the lookup found, SQL NULL setting a JSON null. */
function Replaced(
  dialect: Dialect,
  document: Compiled,
  key: string,
  value: Compiled,
): Compiled {
  const entry: [string, Sql] = [key, AsJson(dialect, value).sql];
  return {
    sql: dialect.sql.json.setKeys(AsJson(dialect, document).sql, [entry]),
    type: ReplacedType(document.type, key, value.type),
  };
}

/**
 * Replaces one key of each row with the row it points at, through a subselect correlated to the
 * row that the dialect brings in. `single` survives, because the relation is not wrapped on the
 * common path.
 */
const LookupStage: PipelineStage = (relation, stage, context) => {
  const keys = KeysOf(stage);
  const prepared = Prepare(relation, LOOKUP_BLOCKERS, context);
  const local = prepared.source.field(keys.localKey);
  const form = FormOf(local, keys.localKey);
  const other = LookedUp(stage, context);
  const under = Correlatable(other);
  if (under) {
    Correlate(other, under, keys, local, form);
  }
  const right = Prepare(other, WHERE_BLOCKERS, context);
  if (!under) {
    Correlate(right, right.source, keys, local, form);
  }
  const answer = CurrentValue(right);
  const subselect = form.subselect(SetProjection(right, answer), context);
  const read = context.dialect.sql.rows.lookup(
    subselect,
    context.nextAlias(),
    OUTPUT_COLUMN,
  );
  if (read.join) {
    prepared.joins.push(read.join);
  }
  const looked: Compiled = {
    sql: read.value,
    type: form.replaced(answer.type),
  };
  return SetProjection(
    prepared,
    Replaced(context.dialect, CurrentValue(prepared), keys.localKey, looked),
  );
};

/** The stages that bring a second query into the pipeline beside the one it is folding. */
export const JOIN_STAGES: PipelineStageMap = {
  join: JoinStage,
  lookup: LookupStage,
};
