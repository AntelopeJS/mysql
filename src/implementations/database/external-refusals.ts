import type { ExternalRelation } from "./fields";

const BACKTICK = "`";

function Quoted(name: string): string {
  return `${BACKTICK}${name.replaceAll(BACKTICK, BACKTICK + BACKTICK)}${BACKTICK}`;
}

/** A relation as a message names it, quoted the way MySQL spells it: `` `sales`.`accounts` ``. */
export function RelationName(
  external: Pick<ExternalRelation, "schema" | "table">,
): string {
  return `${Quoted(external.schema)}.${Quoted(external.table)}`;
}

/**
 * Refuses `atomicMutation`, whose contract needs a missing field told apart from a NULL one, which a
 * declared SQL column cannot do.
 */
export function ExternalWriteRefusal(
  external: ExternalRelation,
  stage: string,
): Error {
  return new Error(
    `The '${stage}' stage is not supported on ${RelationName(external)}, an external relation: its contract tells a missing field from a NULL one, which a column cannot`,
  );
}

/** Refuses a feed, which needs the change log and triggers an owned table has and this one does not. */
export function ExternalFeedRefusal(external: ExternalRelation): Error {
  return new Error(
    `changes() needs the adapter's change log, which ${RelationName(external)} does not have: it is an external relation, and the adapter installs nothing on it`,
  );
}

/** Refuses an instance lifecycle stage, since an external relation has no instances to manage. */
export function ExternalInstanceRefusal(stage: string): Error {
  return new Error(
    `The '${stage}' stage manages instances, and an external instance's relations have none: read them through the default instance`,
  );
}

/** Refuses reading by key a relation that has none, naming the field reads that still work. */
export function KeylessRefusal(external: ExternalRelation): Error {
  return new Error(
    `${RelationName(external)} has no primary key and no unique index over NOT NULL columns, so its rows have no _id and cannot be read by key: filter on a field, or getAll by a field name`,
  );
}
