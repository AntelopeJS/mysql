import assert from "node:assert";
import type {
  QueryStage,
  StagedObject,
} from "@antelopejs/interface-database/common";
import {
  CROSS_INSTANCE,
  type InstanceId,
  type SchemaDefinition,
} from "@antelopejs/interface-database/schema";
import { Schema } from "@antelopejs/interface-database/staged-query";

import { DIALECTS, type Dialect } from "../../dialect";
import { Bind, type Bound } from "../../statement";
import { ParseSchema } from "../../implementations/database/fields";
import {
  BuildSchemaPlan,
  IndexFields,
  type TablePlan,
} from "../../implementations/database/plan";
import { DecodingContext } from "../../implementations/database/context";
import { CompileExpression } from "../../implementations/database/expression";
import { CompileSubquery } from "../../implementations/database/subquery";
import {
  ApplyStages,
  CompileRelation,
} from "../../implementations/database/pipeline";
import {
  BuildRoot,
  type OriginResolver,
} from "../../implementations/database/selection";
import type { Relation } from "../../implementations/database/relation";
import { Render } from "../../implementations/database/render";
import {
  CompileWrite,
  SplitWrite,
} from "../../implementations/database/writes";
import {
  type WriteStatement,
  WriteTargetOf,
} from "../../implementations/database/writes-shared";

const SCHEMA_ID = "directory";

/** What the specs keep in the opaque `meta` column. */
interface Meta {
  title?: string;
  owner?: string;
}

/**
 * A person as a caller declares one: its own row type, which spells keys the schema leaves to the
 * overflow column, and the index names a selection reads by.
 */
export interface Person {
  _id: string;
  name: string;
  age: number;
  isActive: boolean;
  joined: Date;
  meta: Meta;
  nickname: string | null;
  rev: string;
  byName: string;
  _internal: { owner: string };
}

interface Product {
  name: string;
  price: number;
}

interface Profile {
  name: string;
  skills: string[];
}

interface Directory {
  people: Person;
  products: Product;
  logs: Record<string, number>;
  profiles: Profile;
}

/**
 * The tables the specs compile against. `people` declares an index on two stored fields, one on a
 * declared string (a prefix key column), a unique one on a path below a declared object (an exact
 * key column) and one on a path below the overflow column; `profiles` holds a list.
 */
const DIRECTORY: SchemaDefinition = {
  people: {
    fields: {
      name: "string",
      age: "number",
      isActive: "boolean",
      joined: "date",
      meta: "object",
    },
    indexes: {
      byAgeActive: { fields: ["age", "isActive"] },
      byName: { fields: ["name"] },
      title: { fields: ["meta.title"], unique: true },
      owner: { fields: ["_internal.owner"] },
    },
  },
  products: { fields: { name: "string", price: "number" }, indexes: {} },
  logs: { fields: {}, indexes: {} },
  profiles: {
    fields: { name: "string", skills: "string[]" },
    indexes: { skills: { fields: ["skills"], multi: true } },
  },
};

const MODEL = ParseSchema(SCHEMA_ID, DIRECTORY);

const PLANS = new Map(
  BuildSchemaPlan(SCHEMA_ID, DIRECTORY, MODEL, {
    prefix: "",
    session: DIALECTS.mysql.session,
  }).tables.map((plan) => [plan.tableId, plan]),
);

/** The plan the stub registry holds for a table, which is what the compiler names its columns from. */
export function PlanOf(tableId: string): TablePlan {
  const plan = PLANS.get(tableId);
  assert(plan, `The fixture declares no table '${tableId}'`);
  return plan;
}

/** The stubbed registry a spec compiles against: real declarations, planned the production way. */
const StubOrigin: OriginResolver = (schemaId, tableId) => ({
  schemaId,
  tableId,
  model: MODEL[tableId],
  plan: PlanOf(tableId),
  index: (name) => {
    const indexes = DIRECTORY[tableId].indexes;
    return Object.hasOwn(indexes, name)
      ? IndexFields(name, indexes[name])
      : [name];
  },
});

/** A context compiling one statement for `dialect`, against the stub registry. */
export function NewContext(dialect: Dialect = DIALECTS.mysql): DecodingContext {
  return new DecodingContext(
    {
      expression: CompileExpression,
      subquery: CompileSubquery,
      relation: CompileRelation,
    },
    dialect,
    StubOrigin,
  );
}

function Table<Name extends keyof Directory>(
  tableId: Name,
  instanceId: InstanceId | undefined,
) {
  return new Schema<Directory>(SCHEMA_ID, DIRECTORY)
    .instance(instanceId)
    .table(tableId);
}

export function Root() {
  return Table("people", undefined);
}

/** The same table read across every instance, which is the absence of an instance predicate. */
export function CrossInstanceRoot() {
  return Table("people", CROSS_INSTANCE);
}

export function Other() {
  return Table("products", undefined);
}

/** The table that declares no fields, whose whole document lives in the overflow column. */
export function LogsRoot() {
  return Table("logs", undefined);
}

/** The table declaring a field whose type is a list, with a `multi` index over it. */
export function ProfilesRoot() {
  return Table("profiles", undefined);
}

/** A read compiled as `RunQuery` compiles one: root, fold, render. */
export function CompiledRelation(
  query: StagedObject,
  context = NewContext(),
): Relation {
  const root = BuildRoot(query.build(), context);
  return ApplyStages(root.relation, root.rest, context);
}

/** A read's statement, as the driver receives it. */
export function Compile(query: StagedObject, dialect?: Dialect): Bound {
  return Bind(Render(CompiledRelation(query, NewContext(dialect))));
}

/** A query whose last stage writes, compiled as `RunQuery` compiles one. */
export function Written(
  query: StagedObject,
  dialect?: Dialect,
): WriteStatement {
  const context = NewContext(dialect);
  const root = BuildRoot(query.build(), context);
  const split = SplitWrite(root.rest);
  assert(split.write, "this fixture compiles a query that ends in a write");
  const relation = ApplyStages(root.relation, split.pipeline, context);
  return CompileWrite(WriteTargetOf(root, relation), split.write, context);
}

/** Every statement a compiled write can run, an upsert's for `existing` keys. */
export function WrittenStatements(
  statement: WriteStatement,
  existing: readonly string[] = [],
): Bound[] {
  switch (statement.kind) {
    case "count":
    case "atomic":
      return [Bind(statement.statement)];
    case "insert":
      return statement.statements.map((one) => Bind(one));
    case "upsert":
      return [statement.lock, ...statement.write(new Set(existing))].map(
        (one) => Bind(one),
      );
  }
}

/** The stages of a recorded query after its `schema`/`instance`/`table` root. */
export function Stages(query: StagedObject): QueryStage[] {
  return query.build().slice(3);
}
