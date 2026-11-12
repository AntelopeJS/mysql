import { Query, ValueProxy } from "@antelopejs/interface-database";
import {
  IsQueryStage,
  type QueryRecord,
  type QueryStage,
  type QueryValue,
  StagedObject,
} from "@antelopejs/interface-database/common";

import { IsBoolean, IsNumber, IsString } from "./guards";
import type { ConstantJson } from "./sql";

/**
 * A non-array object read as a document: its own members, classified when they are asked for.
 *
 * Each call reads the object again, as `Object.entries` and a property read do, so a getter runs
 * exactly when the walk that asked for it runs.
 */
export interface DocumentView {
  entries(): [string, Member][];
  /** The member at an own key, or `undefined` for a key the object does not own. */
  own(name: string): Member | undefined;
  ownNames(): string[];
}

/** What every member answers, whichever kind it is. */
interface MemberFacts {
  /** The value as `JSON.stringify` spells it, for a message or a key's text. */
  json(): string;
  /** The value read as a document, for a non-array object. */
  document: DocumentView | undefined;
  /** Refuses the value as one a query cannot decode, naming its kind. */
  refuseInQuery(): never;
}

interface Scalar<Kind extends string, Value> extends MemberFacts {
  kind: Kind;
  value: Value;
}

interface Staged<Kind extends string> extends Scalar<Kind, StagedObject> {
  identity: object;
}

/** A list, whose items are classified when they are asked for, so a cyclic list costs nothing. */
export interface ListMember extends MemberFacts {
  kind: "list";
  identity: object;
  items(): Member[];
  /** The list itself when every item is json the driver can send whole. */
  constant(): ConstantJson[] | undefined;
}

/** An object literal, as opposed to an instance of something. */
interface RecordMember extends MemberFacts {
  kind: "record";
  identity: object;
  document: DocumentView;
}

/** A value no walk reads: a `bigint`, a `symbol`, a function or an instance such as a `Buffer`. */
interface OpaqueMember extends MemberFacts {
  kind: "opaque";
}

interface Marker<Kind extends string> extends MemberFacts {
  kind: Kind;
}

/**
 * One value out of a caller's document or a stage's arguments, parsed once into what it is.
 *
 * The walkers branch on `kind` and read only what that kind carries. `opaque` carries nothing but
 * the facts, so a walk that ignores it (a read-only column) leaves it alone and one that decodes it
 * refuses it, as the caller's value was before it was parsed.
 */
export type Member =
  | Marker<"absent">
  | Marker<"null">
  | Scalar<"text", string>
  | Scalar<"number", number>
  | Scalar<"boolean", boolean>
  | Scalar<"date", Date>
  | Staged<"proxy">
  | Staged<"query">
  | Staged<"staged">
  | ListMember
  | RecordMember
  | OpaqueMember;

/** Whether a document is an object literal rather than an instance of something. */
function IsRecordLiteral(value: QueryRecord): boolean {
  return Object.getPrototypeOf(value) === Object.prototype;
}

/** Whether an operand is a list; its items are operands by the operand type itself. */
export function IsList(value: QueryValue): value is readonly QueryValue[] {
  return Array.isArray(value);
}

/**
 * Whether a value is JSON the driver can send whole, rather than an expression to compile.
 *
 * A `ValueProxy` or a `Query` reads the row and has to be emitted as SQL; a `Date` is deliberately
 * excluded because the engine's JSON spelling of an instant and `JSON.stringify`'s differ.
 */
function IsConstantJson(value: QueryValue): value is ConstantJson {
  if (value === null) {
    return true;
  }
  if (IsList(value)) {
    return value.every(IsConstantJson);
  }
  if (IsString(value) || IsNumber(value) || IsBoolean(value)) {
    return true;
  }
  if (
    value === undefined ||
    value instanceof StagedObject ||
    value instanceof Date ||
    !IsRecordLiteral(value)
  ) {
    return false;
  }
  return Object.values(value).every(
    (item) => item === undefined || IsConstantJson(item),
  );
}

/** A document's own members, read again on every call so a getter runs when the walk asks. */
function DocumentOf(value: QueryRecord): DocumentView {
  return {
    entries: () =>
      Object.entries(value).map(([name, item]) => [name, ClassifyMember(item)]),
    own: (name) =>
      Object.hasOwn(value, name) ? ClassifyMember(value[name]) : undefined,
    ownNames: () => Object.getOwnPropertyNames(value),
  };
}

/**
 * Parses one caller value into the kind every walker branches on. Total: every value has a kind.
 *
 * It looks at the value and goes no deeper, so a cyclic document in a column the walk ignores is
 * never walked. The order is the order the kinds were always told apart in, which is what makes a
 * `ValueProxy` a proxy before it is an object. Only an object that is neither staged, a date nor a
 * list reads as a document, and only an object literal is a `record`; an instance of anything else
 * is `opaque`, and still a document to a walk that reads its own keys.
 */
export function ClassifyMember(value: QueryValue): Member {
  const of = <Kind extends Member["kind"]>(
    kind: Kind,
    document?: DocumentView,
  ): MemberFacts & { kind: Kind } => ({
    kind,
    json: () => JSON.stringify(value),
    document,
    refuseInQuery: () => {
      throw new Error(`Unsupported value of kind '${kind}' in query`);
    },
  });
  if (value === undefined) {
    return of("absent");
  }
  if (value === null) {
    return of("null");
  }
  if (value instanceof ValueProxy) {
    return { ...of("proxy"), value, identity: value };
  }
  if (value instanceof Query) {
    return { ...of("query"), value, identity: value };
  }
  if (value instanceof StagedObject) {
    return { ...of("staged"), value, identity: value };
  }
  if (value instanceof Date) {
    return { ...of("date"), value };
  }
  if (IsList(value)) {
    const list: readonly QueryValue[] = value;
    return {
      ...of("list"),
      identity: list,
      items: () => list.map((item) => ClassifyMember(item)),
      constant: () => (list.every(IsConstantJson) ? [...list] : undefined),
    };
  }
  if (IsString(value)) {
    return { ...of("text"), value };
  }
  if (IsNumber(value)) {
    return { ...of("number"), value };
  }
  if (IsBoolean(value)) {
    return { ...of("boolean"), value };
  }
  const document = DocumentOf(value);
  if (IsRecordLiteral(value)) {
    return { ...of("record", document), identity: value, document };
  }
  return of("opaque", document);
}

/** Whether an operand is a document: an object that is neither staged, a date nor a list. */
export function IsOperandRecord(value: QueryValue): value is QueryRecord {
  return (
    value !== null &&
    value !== undefined &&
    !IsList(value) &&
    !(value instanceof StagedObject) &&
    !(value instanceof Date) &&
    !IsString(value) &&
    !IsNumber(value) &&
    !IsBoolean(value)
  );
}

/**
 * The operand a stage records at `index`. Every stage but `atomicMutation` records operands, which
 * the interface types as `QueryValue`; that one records a key and a request and is read field by
 * field instead.
 */
export function StageOperand(stage: QueryStage, index: number): QueryValue {
  if (IsQueryStage(stage, "atomicMutation")) {
    throw new Error(
      `The '${stage.stage}' stage records a key and a request, not operands`,
    );
  }
  return stage.args[index];
}
