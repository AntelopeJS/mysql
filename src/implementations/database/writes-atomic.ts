import assert from "node:assert";
import { ValidateAtomicMutation } from "@antelopejs/interface-database/atomic";
import { IsQueryStage } from "@antelopejs/interface-database/common";
import type {
  AtomicMutation,
  AtomicMutationOutcome,
  AtomicDelete,
  AtomicRecord,
  AtomicUpdate,
} from "@antelopejs/interface-database";

import type { Dialect } from "../../dialect";
import { type Sql, join, sql } from "../../statement";
import { DecodeValue } from "./value";
import { OPAQUE } from "./types";
import { UnifyOperands } from "./coerce";
import { Compared } from "./json";
import type { DecodingContext } from "./context";
import { JsonParam, QualifiedColumn, TextParam } from "./sql";
import { ID_AS_ASSERTION, SplitPayload } from "./payload";
import {
  EXTRA_COLUMN,
  ID_COLUMN,
  INSTANCE_COLUMN,
  RESERVED_COLUMNS,
} from "./utils";
import {
  Assignment,
  MergeExtra,
  RequireInstance,
  WRITE_ALIAS,
  type WriteCompiler,
  WriteTable,
  type WriteTarget,
  WriteRowSource,
} from "./writes-shared";
import { IsString } from "./guards";
import { ClassifyMember } from "./member";

export const ATOMIC_MUTATION = "atomicMutation";
const ATOMIC_ARGUMENT_COUNT = 2;

type Mutation = AtomicMutation<AtomicRecord>;
type RevisionMutation = AtomicDelete<AtomicRecord> | AtomicUpdate<AtomicRecord>;

/**
 * The revision test a guarded mutation applies. A declared revision column compares as text; an
 * undeclared one compares as the JSON string it was written as, and a revision that is not there
 * yet is the absence of the key, since a declared column cannot tell absence from null.
 */
function RevisionPredicate(
  target: WriteTarget,
  request: RevisionMutation,
  context: DecodingContext,
): Sql {
  const dialect = context.dialect;
  const { revisionField, expectedRevision } = request;
  const declared = Object.hasOwn(target.origin.model.fields, revisionField)
    ? target.origin.model.fields[revisionField]
    : undefined;
  if (declared) {
    assert(
      IsString(expectedRevision),
      "Missing revision bootstrap is unsupported for declared MySQL columns: absent and null share SQL NULL",
    );
    assert(
      declared.type.kind === "text",
      "A declared revision field must be text",
    );
    return sql`${QualifiedColumn(WRITE_ALIAS, declared.column)} = ${TextParam(dialect, expectedRevision).sql}`;
  }
  const extra = QualifiedColumn(WRITE_ALIAS, EXTRA_COLUMN);
  const json = dialect.sql.json;
  if (!IsString(expectedRevision)) {
    return sql`NOT ${json.hasKey(extra, revisionField)}`;
  }
  const expected = JsonParam(dialect, expectedRevision, OPAQUE);
  return json.compare(json.member(extra, revisionField), expected.sql, "=");
}

function AtomicAssignments(
  target: WriteTarget,
  request: Mutation,
  context: DecodingContext,
): Sql {
  assert(request.type === "update", "Expected an update mutation");
  const document = {
    ...request.patch,
    [request.revisionField]: request.nextRevision,
  };
  const view = ClassifyMember(document).document;
  assert(view, "A patch spread into a literal is a document");
  const split = SplitPayload(view, target.origin.model, context, {
    id: ID_AS_ASSERTION,
  });
  const assignments = split.members.map((member) =>
    Assignment(member.column, member.value.sql),
  );
  if (split.extra) {
    assignments.push(
      Assignment(EXTRA_COLUMN, MergeExtra(context.dialect, split.extra)),
    );
  }
  return join(assignments, sql`, `);
}

function AtomicPredicate(
  target: WriteTarget,
  request: Mutation,
  context: DecodingContext,
): Sql {
  if (request.type !== "deleteIfEqual") {
    return RevisionPredicate(target, request, context);
  }
  const expected = DecodeValue(ClassifyMember(request.expectedValue), context);
  assert(expected, "Expected a constant equality value");
  const field = WriteRowSource(
    context.dialect,
    target.origin,
    WRITE_ALIAS,
  ).field(request.field);
  const pair = UnifyOperands(context.dialect, field, expected);
  return Compared(context.dialect, pair.left, pair.right, "=");
}

/**
 * One `UPDATE` or `DELETE` of the keyed row, guarded by the request's predicate, so the server
 * decides the race: the row matched or it did not.
 */
export const AtomicWrite: WriteCompiler = (target, stage, context) => {
  assert(
    IsQueryStage(stage, ATOMIC_MUTATION) &&
      stage.options === undefined &&
      stage.args.length === ATOMIC_ARGUMENT_COUNT,
    "Atomic mutation requires exactly a key and request without options",
  );
  const instance = RequireInstance(target, stage);
  const [key, request] = stage.args;
  ValidateAtomicMutation(key, request, RESERVED_COLUMNS);
  const where = join(
    [
      sql`${QualifiedColumn(WRITE_ALIAS, INSTANCE_COLUMN)} = ${instance.sql}`,
      sql`${QualifiedColumn(WRITE_ALIAS, ID_COLUMN)} = ${TextParam(context.dialect, key).sql}`,
      AtomicPredicate(target, request, context),
    ],
    sql` AND `,
  );
  const table = WriteTable(target.origin);
  const command =
    request.type === "update"
      ? sql`UPDATE ${table} SET ${AtomicAssignments(target, request, context)}`
      : sql`DELETE FROM ${table}`;
  return { kind: "atomic", statement: sql`${command} WHERE ${where}` };
};

/**
 * The outcome of a guarded mutation, from the rows it matched: one is `applied`, none
 * `not-applied`. An error the server answered is rethrown, since the statement did not apply;
 * anything else — a lost connection, a lost acknowledgement — is `unknown`, since it may have.
 */
export async function ExecuteAtomicWrite(
  dialect: Dialect,
  execute: () => Promise<number>,
): Promise<AtomicMutationOutcome> {
  try {
    const matched = await execute();
    return matched === 0 ? "not-applied" : "applied";
  } catch (error) {
    if (
      error instanceof Error &&
      dialect.errors.classify(error).kind !== "connection"
    ) {
      throw error;
    }
    return "unknown";
  }
}
