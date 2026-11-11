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
