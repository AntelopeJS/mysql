import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";
import type { QueryStage } from "@antelopejs/interface-database/common";

import { IsBoolean, IsNumber, IsObject, IsString } from "./guards";

export const ID_COLUMN = "_id";
export const INSTANCE_COLUMN = "_instance";
export const EXTRA_COLUMN = "_extra";

/** Columns the adapter owns; no declared field and no overflow key may land in one. */
export const RESERVED_COLUMNS: readonly string[] = [
  ID_COLUMN,
  INSTANCE_COLUMN,
  EXTRA_COLUMN,
];

/**
 * The longest `_id`, in characters. With {@link MAX_INSTANCE_ID_CHARS} it keeps the primary key
 * within InnoDB's 3072-byte key limit at four bytes per character: 2048 + 512 bytes.
 */
export const MAX_KEY_CHARS = 512;

/** The longest instance id, in characters; every index leads with it, so it is kept short. */
export const MAX_INSTANCE_ID_CHARS = 128;

/** Instance id stored for the unnamed (default) instance. */
export const DEFAULT_INSTANCE_ID = "";

const CREATE_INSTANCE = "createInstance";
const DESTROY_INSTANCE = "destroyInstance";

/**
 * The lifecycle stages that resolve an instance id, named once for both the
 * handler map that dispatches them and the errors that report them.
 */
export type InstanceOperation =
  | typeof CREATE_INSTANCE
  | typeof DESTROY_INSTANCE;

/** How a value a caller passed instead of a string is named, first match wins. */
const RECEIVED_KINDS = [
  ["number", IsNumber],
  ["boolean", IsBoolean],
  ["list", Array.isArray],
  ["document", IsObject],
] as const;

type RecordedOptions = Exclude<QueryStage["options"], undefined>;

type OptionName = RecordedOptions extends infer Options
  ? Options extends unknown
    ? keyof Options
    : never
  : never;

type OptionType<Name extends OptionName> = RecordedOptions extends infer Options
  ? Options extends unknown
    ? Name extends keyof Options
      ? Options[Name]
      : never
    : never
  : never;

/** Every option a stage records, each typed as the stages that record it declare it. */
type StageOptions = { readonly [Name in OptionName]?: OptionType<Name> };

/**
 * The options a stage records, read whatever its name, for readers that check each option they
 * read: `OptionsOf(stage)?.id` reads what `stage.options?.id` reads.
 */
function OptionsOf(stage: QueryStage | undefined): StageOptions | undefined {
  return stage?.options;
}

/**
 * Resolves the instance id an instance lifecycle stage names.
 *
 * An omitted id means the default instance, which is stored as the empty
 * string rather than as NULL so it compares like any other. An id passed
 * explicitly as `""` is that same default instance, not a named instance whose
 * name happens to be empty — the two are indistinguishable by construction.
 * `CROSS_INSTANCE` selects rows across instances and so has no meaning for an
 * operation that creates, destroys or enumerates one; it is rejected by name so
 * the caller sees which stage refused it. An id longer than the `_instance`
 * column is refused with the limit, rather than failing in the statement.
 */
export function NormalizeInstanceId(
  operation: InstanceOperation,
  stage: QueryStage,
): string {
  const id: unknown = OptionsOf(stage)?.id;
  if (id === CROSS_INSTANCE) {
    throw new Error(
      `${operation} does not accept CROSS_INSTANCE: pass a string id or omit it for the default instance`,
    );
  }
  if (id === undefined || id === null) {
    return DEFAULT_INSTANCE_ID;
  }
  if (!IsString(id)) {
    throw new Error(
      `${operation} expects a string instance id, received ${RECEIVED_KINDS.find(([, test]) => test(id))?.[0] ?? "value"}`,
    );
  }
  if (Array.from(id).length > MAX_INSTANCE_ID_CHARS) {
    throw new Error(
      `${operation} received an instance id longer than ${MAX_INSTANCE_ID_CHARS} characters, the most an instance id may hold`,
    );
  }
  return id;
}
