import assert from "node:assert";

import { sql } from "../../statement";
import type { Compiled } from "./sql";
import { AsJson, WrittenAs } from "./readings";
import { DecodeValue } from "./value";
import type { DocumentView, Member } from "./member";
import { IsJsonBacked, JsonOf, type SqlType, TEXT } from "./types";
import type { DecodingContext } from "./context";
import type { TableModel } from "./fields";
import { ID_COLUMN, INSTANCE_COLUMN, RESERVED_COLUMNS } from "./utils";

/**
 * One column a payload writes, named by its column rather than by its field.
 *
 * The two differ whenever `MysqlIdentifier` cut the field name, and a member is
 * not always a declared field: `_id` is a member too when the stage is keyed by it, and `_id` is
 * never in `TableModel.fields`.
 */
interface PayloadMember {
  column: string;
  value: Compiled;
}

/**
 * A payload's keys, sorted by what the write has to do with each.
 *
 * The two removal lists are not interchangeable: `cleared` names declared columns the write sets
 * to NULL, while `removed` names undeclared keys it subtracts from the overflow document. A key
 * routed to the wrong one still compiles and still writes — it just writes to the other half of
 * the row.
 *
 * `identity` is the odd one out: it is not something the write *writes* but something the payload
 * *claims* about the row it targets — the `_id` a caller supplied, present only where the stage
 * reads one that way. A write that assigned it instead would change the identity of the row it had
 * already found.
 */
export interface PayloadSplit {
  members: PayloadMember[];
  cleared: string[];
  extra?: OverflowMembers;
  removed: string[];
  identity?: Compiled;
}

/**
 * The undeclared keys a payload writes, each already JSON, beside the document they make: a write
 * that merges sets the keys one by one, and one that replaces writes the document whole.
 */
export interface OverflowMembers {
  entries: [string, Compiled][];
  document: Compiled;
}

/** SQL NULL, which is what a declared column holds for a field that is absent or null. */
export const NULL_VALUE = sql`NULL`;

/**
 * A payload's written members, indexed by the column each of them lands in.
 *
 * The projection the writes that fill a **fixed** column list need — `replace` names every declared
 * column and `insert` names the batch's union — where the split itself is ordered by what the
 * caller wrote. Shared so the two spell the key the same way: a member is keyed by `column` and
 * never by the field name it was declared under.
 */
export function MembersByColumn(split: PayloadSplit): Map<string, Compiled> {
  return new Map(split.members.map((member) => [member.column, member.value]));
}

/**
 * Where a supplied `_id` lands in the split, which is what the stage doing the writing decides.
 *
 * The disposition is the whole difference between the two walks, so it is the behaviour itself
 * rather than a flag a second `if` then reads: the value is compiled the same way for both, and
 * only its destination differs.
 */
export type IdDisposition = (split: PayloadSplit, value: Compiled) => void;

/** `insert` is keyed by its payload, so the `_id` it supplies is a column the new row writes. */
export const ID_AS_KEY: IdDisposition = (split, value) => {
  split.members.push({ column: ID_COLUMN, value });
};

/**
 * `update` and `replace` are keyed by what they targeted, so an `_id` states which row that is.
 *
 * Never an assignment: the write already found its rows, and a payload's `_id` narrows them to the
 * one it names rather than renaming what was found. A key naming some other row therefore matches
 * nothing and the write answers 0, which is what makes writing a document straight back — `_id`
 * and all — a no-op rather than an error.
 */
export const ID_AS_ASSERTION: IdDisposition = (split, value) => {
  split.identity = value;
};

/**
 * What the stage doing the writing does with the reserved columns.
 *
 * `_extra` is the adapter's own and is refused under every stage. `_id` and `_instance` are the
 * two a read document carries: `id` says what this stage makes of the first, and the second is
 * dropped under all of them for the reason {@link TakeKey} gives.
 */
export interface PayloadOptions {
  id: IdDisposition;
}

const ADAPTER_OWNED =
  "is a column this adapter owns and no payload may write it";

function Refusal(name: string): Error {
  return new Error(`Payload key '${name}' ${ADAPTER_OWNED}`);
}

interface PayloadWalk {
  split: PayloadSplit;
  added: [string, Member][];
  model: TableModel;
  context: DecodingContext;
  options: PayloadOptions;
}

/** The undeclared members as JSON, and the document they make together. */
function Overflow(
  added: [string, Member][],
  context: DecodingContext,
): OverflowMembers {
  const entries: [string, Compiled][] = [];
  const keyTypes: Record<string, SqlType> = {};
  for (const [name, member] of added) {
    const value = DecodeValue(member, context);
    if (!value) {
      continue;
    }
    entries.push([name, AsJson(context.dialect, value)]);
    keyTypes[name] = value.type;
  }
  const document = context.dialect.sql.json.object(
    entries.map(([name, value]) => [name, value.sql]),
  );
  return { entries, document: { sql: document, type: JsonOf(keyTypes) } };
}

function Decoded(walk: PayloadWalk, value: Member): Compiled {
  const compiled = DecodeValue(value, walk.context);
  assert(compiled, "A supplied payload value always decodes");
  return compiled;
}

/**
 * Whether a payload supplied no `_id`, which `null` means exactly as `undefined` does.
 *
 * The rule has one owner because both stages have to read a key the same way: one
 * that generated a key on the way in but asserted a null on the way back would answer 0 for the
 * document it had just written.
 */
export function NoIdSupplied(value: Member): boolean {
  return value.kind === "absent" || value.kind === "null";
}

/** Names a key in the message {@link WrittenAs} raises for a value the column cannot hold. */
function KeySubject(name: string): string {
  return `Payload key '${name}'`;
}

/**
 * Sorts one key of a payload into the split.
 *
 * The two reserved columns a payload may name are routed, and the one it may not is refused. The
 * key is read as `TEXT` the way `get` reads it, and no value at all asserts nothing.
 *
 * `_instance` is read and dropped rather than refused, because it is a key every read document
 * carries and writing one straight back has to be the no-op the same round trip through `_id` is.
 * Dropping it is not passing over a claim the caller made: a scoped write is already pinned to one
 * instance, and a cross-instance one addresses its rows by an identity tuple that names each row's
 * instance, so no reachable write would target different rows for having honoured it. It is never
 * an assignment either — a write does not move a row between instances.
 *
 * A declared field is written into its own typed column, read as that column's type. A null is SQL
 * NULL and never a stored JSON null, so the read, `pluck` and `hasfields` agree.
 */
function TakeKey(walk: PayloadWalk, name: string, value: Member): void {
  if (RESERVED_COLUMNS.includes(name)) {
    if (name === INSTANCE_COLUMN) {
      return;
    }
    if (name !== ID_COLUMN) {
      throw Refusal(name);
    }
    if (NoIdSupplied(value)) {
      return;
    }
    walk.options.id(
      walk.split,
      WrittenAs(
        walk.context.dialect,
        Decoded(walk, value),
        TEXT,
        KeySubject(name),
      ),
    );
    return;
  }
  if (Object.hasOwn(walk.model.fields, name)) {
    const spec = walk.model.fields[name];
    if (value.kind === "absent") {
      walk.split.cleared.push(spec.column);
      return;
    }
    if (value.kind === "null" && IsJsonBacked(spec.type)) {
      walk.split.members.push({
        column: spec.column,
        value: { sql: NULL_VALUE, type: spec.type },
      });
      return;
    }
    walk.split.members.push({
      column: spec.column,
      value: WrittenAs(
        walk.context.dialect,
        Decoded(walk, value),
        spec.type,
        KeySubject(name),
      ),
    });
    return;
  }
  if (value.kind === "absent") {
    walk.split.removed.push(name);
    return;
  }
  walk.added.push([name, value]);
}

/**
 * Classifies a write payload against the shape the table declares.
 *
 * A declared field is written into its own typed column, read as that column's type rather than
 * cast to it — see {@link WrittenAs}. Anything else is a member of the overflow document, and the
 * reserved columns are answered by `options`.
 *
 * `undefined` and `null` are different instructions and only one of them survives decoding: a
 * `null` is a value and is written as a JSON null, while `undefined` means *remove the field* and
 * is therefore read off the raw payload here, before anything is decoded — a decoded removal is
 * indistinguishable from a key that was never written. The walk reads the payload's own entries
 * rather than its defined values, since a key present with an `undefined` value is still a key the
 * caller wrote. That rule holds for every declared field and every undeclared key; `_id` is its one
 * exception and {@link TakeKey} states why, since a null is neither a value it could store nor
 * a claim it could make.
 */
export function SplitPayload(
  document: DocumentView,
  model: TableModel,
  context: DecodingContext,
  options: PayloadOptions,
): PayloadSplit {
  const walk: PayloadWalk = {
    split: { members: [], cleared: [], removed: [] },
    added: [],
    model,
    context,
    options,
  };
  for (const [name, value] of document.entries()) {
    TakeKey(walk, name, value);
  }
  if (walk.added.length > 0) {
    walk.split.extra = Overflow(walk.added, context);
  }
  return walk.split;
}
