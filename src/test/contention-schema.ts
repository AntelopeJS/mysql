import type { SchemaDefinition } from "@antelopejs/interface-database/schema";

/** The environment a registering process reads its database URL and schema id from. */
export const URL_VARIABLE = "MYSQL_CONTENTION_URL";
export const SCHEMA_VARIABLE = "MYSQL_CONTENTION_SCHEMA";

/** The table before the contended registration: rows hold field `b` in `_extra`. */
export const BEFORE: SchemaDefinition = {
  items: { fields: { a: "string" }, indexes: {} },
};

/**
 * What every contender registers: `b` becomes a column, backfilled from `_extra`, and three indexes
 * need key columns, one of them unique. Both phases have work to do, so contenders meet in each.
 */
export const CONTENDED: SchemaDefinition = {
  items: {
    fields: { a: "string", b: "string" },
    indexes: {
      a: { unique: true },
      b: { crossInstance: true },
      note: { fields: ["note.text"] },
    },
  },
};

/** The environment a registering process reads the name of its definition from. */
export const DEFINITION_VARIABLE = "MYSQL_CONTENTION_DEFINITION";

/** What an older replica of the feed tests declares: `size` is not a field of it yet. */
const NARROW_ROWS: SchemaDefinition = {
  rows: { fields: { label: "string" }, indexes: {} },
};

const NAMED = { contended: CONTENDED, narrow: NARROW_ROWS };

/** The name of a definition a registering process can be told to register. */
export type DefinitionName = keyof typeof NAMED;

/** The definitions a registering process can be told to register, by name. */
export const DEFINITIONS: ReadonlyMap<string, SchemaDefinition> = new Map(
  Object.entries(NAMED),
);
