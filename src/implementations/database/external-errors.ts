import type { Dialect } from "../../dialect";
import type {
  ExternalFailure,
  ExternalFailureKind,
} from "../../dialect/external";
import type { ExternalRelation } from "./fields";
import { RelationName } from "./external-refusals";

/** What went wrong with a write, in terms a caller can act on without reading the engine's errnos. */
export type ExternalWriteErrorKind = ExternalFailureKind;

/** What an {@link ExternalWriteError} says beside its message. */
interface ExternalWriteFacts {
  kind: ExternalWriteErrorKind;
  fields?: string[];
  constraint?: string;
  code?: string;
  detail?: string;
}

/**
 * A write to an external relation the database, or the adapter on its behalf, refused.
 *
 * It carries what a later mapping to an HTTP status needs (the kind, the field or the constraint,
 * the server's errno and message) without importing anything an interface package defines.
 */
export class ExternalWriteError extends Error {
  public readonly kind: ExternalWriteErrorKind;
  public readonly fields: string[];
  public readonly constraint?: string;
  public readonly code?: string;
  public readonly detail?: string;

  public constructor(message: string, facts: ExternalWriteFacts) {
    super(message);
    this.name = "ExternalWriteError";
    this.kind = facts.kind;
    this.fields = facts.fields ?? [];
    this.constraint = facts.constraint;
    this.code = facts.code;
    this.detail = facts.detail;
  }
}

/** The index a duplicate names, without the `table.` the server prefixes it with. */
function IndexOf(key: string | undefined, external: ExternalRelation) {
  const prefix = `${external.table}.`;
  return key?.startsWith(prefix) ? key.slice(prefix.length) : key;
}

type Message = (
  failure: ExternalFailure,
  external: ExternalRelation,
  detail: string,
) => string;

const MESSAGES: Record<ExternalWriteErrorKind, Message> = {
  invalid: (failure, external, detail) =>
    `Field '${external.schema}.${external.table}.${failure.column ?? "?"}' cannot hold the value written: ${detail}`,
  missing: (failure, external) =>
    `Field '${external.schema}.${external.table}.${failure.column ?? "?"}' of ${RelationName(external)} is required`,
  duplicate: (failure, external, detail) =>
    `A row of ${RelationName(external)} already has this value of unique \`${IndexOf(failure.constraint, external) ?? "?"}\`: ${detail}`,
  reference: (failure, external, detail) =>
    `A referenced row does not exist for \`${failure.constraint ?? "?"}\` of ${RelationName(external)}: ${detail}`,
  referenced: (failure, external, detail) =>
    `The row of ${RelationName(external)} is still referenced through \`${failure.constraint ?? "?"}\`: ${detail}`,
  check: (failure, external) =>
    `The row breaks check \`${failure.constraint ?? "?"}\` of ${RelationName(external)}`,
  forbidden: (_failure, external, detail) =>
    `The connected account may not write to ${RelationName(external)}: ${detail}`,
};

/** A server error from writing an external relation, as a readable {@link ExternalWriteError}. */
export function ExternalWriteFailure(
  dialect: Dialect,
  error: Error,
  external: ExternalRelation,
): Error {
  const failure = dialect.external.failure(error);
  if (!failure) {
    return error;
  }
  const constraint =
    failure.kind === "duplicate"
      ? IndexOf(failure.constraint, external)
      : failure.constraint;
  return new ExternalWriteError(
    MESSAGES[failure.kind](failure, external, error.message),
    {
      kind: failure.kind,
      fields: failure.column === undefined ? [] : [failure.column],
      constraint,
      code: failure.code,
      detail: error.message,
    },
  );
}

/** A value a check refused before the write ran, with the field it was given for. */
export interface RefusedValue {
  readonly field: string;
  readonly message: string;
}

/** The write a validation refused before it ran, naming every field that failed. */
export function InvalidValues(refused: readonly RefusedValue[]): Error {
  return new ExternalWriteError(
    refused.map((value) => value.message).join("; "),
    { kind: "invalid", fields: refused.map((value) => value.field) },
  );
}
