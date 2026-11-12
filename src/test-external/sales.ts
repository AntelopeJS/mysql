import {
  Schema,
  type SchemaDefinition,
} from "@antelopejs/interface-database/schema";

import { Read, Write } from "../connection";
import type { Sql } from "../statement";
import { WaitForSchemaReady } from "../implementations/database/schema";

const SALES = "sales";

/**
 * The fixture declared as a generator writes it from the catalog: native names, every key column a
 * field of its own, and `_id` on each relation that has a key.
 */
const SALES_DEFINITION: SchemaDefinition = {
  accounts: {
    fields: {
      _id: "string",
      id: "string",
      name: "string",
      email: "string",
      status: "string",
      revenue: "number",
      score: "number",
      created_at: "date",
      signed_on: "date",
      last_seen: "date",
      external_ref: "string",
      active: "boolean",
      big_counter: "string",
      meta: "object",
      tags: "string[]",
    },
    indexes: {},
  },
  contacts: {
    fields: {
      _id: "string",
      contact_id: "string",
      account_id: "string",
      first_name: "string",
      created_at: "date",
    },
    indexes: {},
  },
  order_lines: {
    fields: {
      _id: "string",
      order_id: "number",
      line_no: "number",
      sku: "string",
      qty: "number",
    },
    indexes: {},
  },
  events: {
    fields: { _id: "string", event_ref: "string", at: "date", msg: "string" },
    indexes: {},
  },
  raw_log: { fields: { at: "date", msg: "string" }, indexes: {} },
  flags: {
    fields: { _id: "string", id: "number", ref: "string", n: "number" },
    indexes: {},
  },
  big_accounts: {
    fields: { id: "string", account_name: "string", revenue: "number" },
    indexes: {},
  },
  daily_signups: { fields: { day: "date", n: "number" }, indexes: {} },
  w_accounts: {
    fields: {
      _id: "string",
      id: "string",
      code: "string",
      email: "string",
      status: "string",
      revenue: "number",
      big: "number",
      rating: "number",
      seen: "date",
      at: "date",
      raw: "object",
      tags: "string[]",
      perms: "string",
      upper_code: "string",
    },
    indexes: {},
  },
  w_items: {
    fields: {
      _id: "string",
      sku: "string",
      account_id: "string",
      qty: "number",
    },
    indexes: {},
  },
  w_serial: {
    fields: { _id: "string", id: "number", label: "string" },
    indexes: {},
  },
  w_events: {
    fields: { _id: "string", at: "date", msg: "string" },
    indexes: {},
  },
  w_big: {
    fields: { _id: "string", id: "number", label: "string" },
    indexes: {},
  },
  w_lines: {
    fields: {
      _id: "string",
      order_id: "number",
      line_no: "number",
      qty: "number",
    },
    indexes: {},
  },
  w_pairs: {
    fields: { _id: "string", a: "string", b: "number", v: "number" },
    indexes: {},
  },
  w_bin_pairs: {
    fields: { _id: "string", a: "string", b: "number", v: "number" },
    indexes: {},
  },
  w_names: {
    fields: {
      _id: "string",
      id: "number",
      name: "string",
      padded: "string",
      legacy: "string",
      narrow: "string",
    },
    indexes: {},
  },
  w_codes: {
    fields: { _id: "string", code: "string", label: "string" },
    indexes: {},
  },
  zero_days: {
    fields: { _id: "string", id: "number", d: "date", dt: "date" },
    indexes: {},
  },
};

type SalesScalar = string | number | boolean | Date | null;

type SalesValue = SalesScalar | SalesScalar[] | Record<string, SalesScalar>;

export type SalesRow = { _id?: string } & Record<string, SalesValue>;

export type SalesTables = Record<string, SalesRow>;

/** Registers the declaration and waits for it, as a generated module's startup does. */
export async function RegisterSales(): Promise<Schema<SalesTables>> {
  const schema = new Schema<SalesTables>(SALES, SALES_DEFINITION);
  await WaitForSchemaReady(SALES);
  return schema;
}

/** A native cell as the server spells it: text, or a number the driver did not stringify. */
export type NativeCell = string | number | null;

/** The rows a native query over the same rows answers, which is what every read is held to. */
export async function Native(
  statement: Sql,
): Promise<Record<string, NativeCell>[]> {
  const rows = await Read(statement);
  return rows.map((row) =>
    Object.fromEntries(
      [...row].map(([column, cell]) => [
        column,
        Buffer.isBuffer(cell) ? cell.toString("utf8") : cell,
      ]),
    ),
  );
}

/** The first column of the first row of a native query, as a number: a count. */
export async function NativeCount(statement: Sql): Promise<number> {
  const [row] = await Read(statement);
  return Number([...row.values()][0]);
}

/** A native statement that writes, answering the rows it matched. */
export function NativeWrite(statement: Sql): Promise<number> {
  return Write(statement);
}
