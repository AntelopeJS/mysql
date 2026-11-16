import {
  IsDocument,
  IsNumber,
  IsString,
} from "./guards";

/** A JSON value; a key of a document that is absent is a key the object lacks. */
export type Json =
  | null
  | number
  | string
  | readonly Json[]
  | { [key: string]: Json };

export type Doc = { [key: string]: Json };

export type Compare = "eq" | "ne" | "gt" | "lt";

export type FieldKind = "number" | "text" | "doc" | "list";

/**
 * What a merged value reads: a constant, a number field changed by a constant, the owners whose
 * `take` equals a number field, the label of the first owner whose `take` reaches a number field,
 * or the outer owner's `take` added to a number field, or the number of members the row has once
 * a member `w` is merged into it.
 */
export type Expression =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "add"; readonly field: string; readonly by: number }
  | { readonly kind: "mul"; readonly field: string; readonly by: number }
  | { readonly kind: "owners"; readonly field: string }
  | { readonly kind: "label"; readonly field: string }
  | { readonly kind: "outer"; readonly field: string }
  | { readonly kind: "keys" };

/** `sum` is the group's `t`: a number field summed, or that field plus the outer `take`. */
export interface GroupSum {
  readonly field: string;
  readonly withOuter: boolean;
}

export type Stage =
  | {
      readonly kind: "filter";
      readonly field: string;
      readonly compare: Compare;
      readonly value: number | string;
    }
  | {
      readonly kind: "filterOuter";
      readonly field: string;
      readonly compare: Compare;
    }
  | {
      readonly kind: "merge";
      readonly name: string;
      readonly expression: Expression;
    }
  | {
      readonly kind: "orderBy";
      readonly field: string;
      readonly direction: "asc" | "desc";
    }
  | {
      readonly kind: "slice";
      readonly offset: number;
      readonly count: number | undefined;
    }
  | { readonly kind: "sliceOuter" }
  | { readonly kind: "pluck"; readonly fields: readonly string[] }
  | { readonly kind: "without"; readonly fields: readonly string[] }
  | {
      readonly kind: "group";
      readonly field: string;
      readonly sum: GroupSum | undefined;
    }
  | { readonly kind: "lookup" }
  | { readonly kind: "lookupList" }
  | { readonly kind: "union" };

export type Terminal =
  | { readonly kind: "rows" }
  | { readonly kind: "count" }
  | { readonly kind: "nth"; readonly at: number }
  | { readonly kind: "nthOuter" };

/** A chain of stages over the items table, run alone or for each owner. */
export interface Chain {
  readonly nested: boolean;
  readonly stages: readonly Stage[];
  readonly terminal: Terminal;
}

/** The tables a chain reads, as the documents the server holds. */
export interface Tables {
  readonly items: readonly Doc[];
  readonly extras: readonly Doc[];
  readonly owners: readonly Doc[];
}

/** What a chain answers: rows in order, or rows whose order is not defined. */
export interface Answer {
  readonly value: Json;
  readonly ordered: boolean;
}

/** Whether a JSON value is a list. */
export function IsList(value: Json): value is readonly Json[] {
  return Array.isArray(value);
}

/** Whether a JSON value is an object of members, not a list or a scalar. */
export function IsMembers(value: Json): value is Doc {
  return IsDocument(value);
}

/** The member of a document, absent when the document lacks it. */
function Member(doc: Doc, field: string): Json | undefined {
  return Object.hasOwn(doc, field) ? doc[field] : undefined;
}

/** The key of a document the tables hold. */
export function IdOf(doc: Doc): string {
  const id = doc._id;
  if (!IsString(id)) {
    throw new Error(`the document ${JSON.stringify(doc)} has no text _id`);
  }
  return id;
}

/** The text of a value with the keys of every document in order, so equal documents agree. */
export function Canonical(value: Json): string {
  if (IsList(value)) {
    return `[${value.map(Canonical).join(",")}]`;
  }
  if (IsMembers(value)) {
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${Canonical(value[key] ?? null)}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

function Present(value: Json | undefined): value is Json {
  return value !== undefined && value !== null;
}

function Rank(value: Json | undefined): number {
  if (value === undefined) {
    return 0;
  }
  return value === null ? 1 : 2;
}

/** Orders values as the module's `orderBy` does: an absent value first, then numbers and text. */
export function Order(left: Json | undefined, right: Json | undefined): number {
  if (Rank(left) !== Rank(right)) {
    return Rank(left) - Rank(right);
  }
  if (IsNumber(left) && IsNumber(right)) {
    return left - right;
  }
  if (IsString(left) && IsString(right)) {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return 0;
}

function Holds(
  value: Json | undefined,
  compare: Compare,
  operand: Json,
): boolean {
  if (compare === "ne") {
    return !(Present(value) && value === operand);
  }
  if (!Present(value)) {
    return false;
  }
  if (compare === "eq") {
    return value === operand;
  }
  const order = Order(value, operand);
  return compare === "gt" ? order > 0 : order < 0;
}

/** Whether a document passes a `filter` stage. */
export function Passes(
  doc: Doc,
  stage: Extract<Stage, { kind: "filter" }>,
): boolean {
  return Holds(Member(doc, stage.field), stage.compare, stage.value);
}

function NumberOf(doc: Doc, field: string): number {
  const value = Member(doc, field);
  if (!IsNumber(value)) {
    throw new Error(
      `the field ${field} is not a number in ${JSON.stringify(doc)}`,
    );
  }
  return value;
}

function Evaluated(
  expression: Expression,
  doc: Doc,
  tables: Tables,
  outer: Doc | undefined,
): Json {
  switch (expression.kind) {
    case "number":
    case "text":
      return expression.value;
    case "add":
      return NumberOf(doc, expression.field) + expression.by;
    case "mul":
      return NumberOf(doc, expression.field) * expression.by;
    case "owners":
      return tables.owners.filter(
        (owner) => owner.take === NumberOf(doc, expression.field),
      ).length;
    case "label": {
      const reached = tables.owners
        .filter(
          (owner) => NumberOf(owner, "take") >= NumberOf(doc, expression.field),
        )
        .sort((left, right) => Order(left._id, right._id));
      return reached[0]?.label ?? null;
    }
    case "outer":
      return NumberOf(doc, expression.field) + NumberOf(outer ?? {}, "take");
    case "keys":
      return new Set([...Object.keys(doc), "w"]).size;
  }
}

function Stable(
  rows: readonly Doc[],
  field: string,
  direction: "asc" | "desc",
): Doc[] {
  const sign = direction === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (left, right) =>
        sign * Order(Member(left.row, field), Member(right.row, field)) ||
        left.index - right.index,
    )
    .map(({ row }) => row);
}

function Picked(doc: Doc, fields: readonly string[], keep: boolean): Doc {
  return Object.fromEntries(
    Object.entries(doc).filter(([name]) => fields.includes(name) === keep),
  );
}

function Summed(
  rows: readonly Doc[],
  sum: GroupSum,
  outer: Doc | undefined,
): number {
  return rows.reduce(
    (total, row) =>
      total +
      NumberOf(row, sum.field) +
      (sum.withOuter ? NumberOf(outer ?? {}, "take") : 0),
    0,
  );
}

function Grouped(
  rows: readonly Doc[],
  stage: Extract<Stage, { kind: "group" }>,
  tables: Tables,
  outer: Doc | undefined,
): Doc[] {
  const groups = new Map<Json, Doc[]>();
  for (const row of rows) {
    const key = Member(row, stage.field) ?? null;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups].map(([key, members]) => {
    const counted = { k: key, c: members.length };
    if (!stage.sum) {
      return counted;
    }
    return { ...counted, t: Summed(members, stage.sum, outer) };
  });
}

/** The owners a row's `refs` name, in the order of the lookup's query: by `_id`, last first. */
function Listed(row: Doc, tables: Tables) {
  const refs = Member(row, "refs");
  const named = refs !== undefined && IsList(refs) ? refs : [];
  return {
    ...row,
    refs: tables.owners
      .filter((owner) => named.some((ref) => ref === IdOf(owner)))
      .sort((left, right) => Order(right._id, left._id)),
  };
}

function Looked(row: Doc, tables: Tables) {
  const id = row.ownerId;
  return {
    ...row,
    ownerId: tables.owners.find((owner) => owner._id === id) ?? null,
  };
}

/** Runs the stages of a chain over `rows`, in memory, as the module is documented to. */
export function Evaluate(
  stages: readonly Stage[],
  source: readonly Doc[],
  tables: Tables,
  outer: Doc | undefined,
): Doc[] {
  let rows = [...source];
  for (const [index, stage] of stages.entries()) {
    switch (stage.kind) {
      case "filter":
        rows = rows.filter((row) => Passes(row, stage));
        break;
      case "filterOuter":
        rows = rows.filter((row) =>
          Holds(
            Member(row, stage.field),
            stage.compare,
            NumberOf(outer ?? {}, "take"),
          ),
        );
        break;
      case "merge":
        rows = rows.map((row) => ({
          ...row,
          [stage.name]: Evaluated(stage.expression, row, tables, outer),
        }));
        break;
      case "orderBy":
        rows = Stable(rows, stage.field, stage.direction);
        break;
      case "slice":
        rows = rows.slice(
          stage.offset,
          stage.count === undefined ? undefined : stage.offset + stage.count,
        );
        break;
      case "sliceOuter":
        rows = rows.slice(0, NumberOf(outer ?? {}, "take"));
        break;
      case "pluck":
        rows = rows.map((row) => Picked(row, stage.fields, true));
        break;
      case "without":
        rows = rows.map((row) => Picked(row, stage.fields, false));
        break;
      case "group":
        rows = Grouped(rows, stage, tables, outer);
        break;
      case "lookup":
        rows = rows.map((row) => Looked(row, tables));
        break;
      case "lookupList":
        rows = rows.map((row) => Listed(row, tables));
        break;
      case "union":
        rows = [
          ...rows,
          ...Evaluate(stages.slice(0, index), tables.extras, tables, outer),
        ];
        break;
    }
  }
  return rows;
}

/** The answer of a terminal over the rows the stages left. */
export function Terminated(
  rows: readonly Doc[],
  terminal: Terminal,
  outer: Doc | undefined,
): Json {
  switch (terminal.kind) {
    case "rows":
      return [...rows];
    case "count":
      return rows.length;
    case "nth":
      return rows[terminal.at] ?? null;
    case "nthOuter":
      return rows[NumberOf(outer ?? {}, "take")] ?? null;
  }
}

/** What a chain answers over the tables, for each owner when it is nested. */
export function Answered(chain: Chain, tables: Tables): Json {
  const run = (outer: Doc | undefined): Json =>
    Terminated(
      Evaluate(chain.stages, tables.items, tables, outer),
      chain.terminal,
      outer,
    );
  if (!chain.nested) {
    return run(undefined);
  }
  return [...tables.owners]
    .sort((left, right) => Order(left._id, right._id))
    .map((owner) => ({ id: owner._id, rows: run(owner) }));
}

/** What a feed writes: an `insert` of an id the table lacks, an `update` or a `delete` of one it has. */
export type Write =
  | { readonly kind: "insert"; readonly doc: Doc }
  | { readonly kind: "update"; readonly id: string; readonly changes: Doc }
  | { readonly kind: "delete"; readonly id: string };

/** An event a feed delivers; a side the event lacks is a key it lacks. */
export interface FeedEvent {
  readonly changeType: "added" | "removed" | "modified";
  readonly oldValue?: Doc;
  readonly newValue?: Doc;
}

/**
 * The events a feed over `stages` delivers for the writes, run from an empty table: a write is
 * delivered when the chain's filters pass either image of the row, and each image is the row
 * after the chain's maps, whether or not its own filters pass.
 */
export function Delivered(
  stages: readonly Stage[],
  writes: readonly Write[],
  tables: Tables,
): FeedEvent[] {
  const unfiltered = stages.filter((stage) => stage.kind !== "filter");
  const matches = (doc: Doc) =>
    Evaluate(stages, [doc], tables, undefined).length === 1;
  const image = (doc: Doc): Doc =>
    Evaluate(unfiltered, [doc], tables, undefined)[0] ?? doc;
  const table = new Map<string, Doc>();
  const events: FeedEvent[] = [];
  for (const write of writes) {
    if (write.kind === "insert") {
      table.set(IdOf(write.doc), write.doc);
      if (matches(write.doc)) {
        events.push({ changeType: "added", newValue: image(write.doc) });
      }
      continue;
    }
    const before = table.get(write.id);
    if (!before) {
      throw new Error(`the script writes a row ${write.id} the table lacks`);
    }
    if (write.kind === "delete") {
      table.delete(write.id);
      if (matches(before)) {
        events.push({ changeType: "removed", oldValue: image(before) });
      }
      continue;
    }
    const after = { ...before, ...write.changes };
    table.set(write.id, after);
    if (matches(before) || matches(after)) {
      events.push({
        changeType: "modified",
        oldValue: image(before),
        newValue: image(after),
      });
    }
  }
  return events;
}
