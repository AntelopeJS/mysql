import assert from "node:assert";
import type { PoolConnection } from "mysql2/promise";

import { Read, type Row, Write } from "../../connection";
import { type Sql, ident, join, param, sql } from "../../statement";
import type { DecodingContext } from "./context";
import { IsString } from "./guards";
import { TableRelation } from "./relation";
import { Render } from "./render";
import { QualifiedColumn } from "./sql";
import { ID_COLUMN, INSTANCE_COLUMN } from "./utils";
import type { WriteTarget } from "./writes-shared";

/** One row's primary key, in the order the key declares its columns. */
interface RowKey {
  readonly instance: string;
  readonly id: string;
}

/** The rows one statement names by key: two bound values each, of the 65,535 a statement takes. */
const KEYS_PER_STATEMENT = 1000;

/**
 * How many times a write locks the rows its selection newly holds and reads the selection again.
 * A row another write moves into the selection after the last read is left out, as one committed
 * after the write would be.
 */
const LOCK_ROUNDS = 3;

const COMMA = sql`, `;

/** The alias the reads here give the table or the selection, apart from every `t`-numbered one. */
const KEY_ALIAS = "k";

const INSTANCE_KEY = "i";
const ID_KEY = "d";

function KeyText(row: Row, name: string): string {
  const value = row.get(name);
  assert(IsString(value), `A row's key column '${name}' reads as text`);
  return value;
}

/** A key as one string, so a set holds each key once. */
function Spelled(key: RowKey): string {
  return JSON.stringify([key.instance, key.id]);
}

/**
 * The keys of the rows the target's read selects, each once and in key order, read from a snapshot
 * that locks no row.
 */
async function Selected(
  target: WriteTarget,
  connection: PoolConnection,
): Promise<RowKey[]> {
  const instance = ident(INSTANCE_KEY);
  const id = ident(ID_KEY);
  const rows = await Read(
    sql`SELECT DISTINCT ${QualifiedColumn(KEY_ALIAS, INSTANCE_COLUMN)} AS ${instance}, ${QualifiedColumn(KEY_ALIAS, ID_COLUMN)} AS ${id} FROM (${Render(target.relation)}) AS ${ident(KEY_ALIAS)} ORDER BY ${instance}, ${id}`,
    connection,
  );
  return rows.map((row) => ({
    instance: KeyText(row, INSTANCE_KEY),
    id: KeyText(row, ID_KEY),
  }));
}

/** Whether the row of the table at `alias` is one of `keys`. */
function Named(alias: string, keys: readonly RowKey[]): Sql {
  const pairs = keys.map(
    (key) => sql`(${param(key.instance)}, ${param(key.id)})`,
  );
  return sql`(${QualifiedColumn(alias, INSTANCE_COLUMN)}, ${QualifiedColumn(alias, ID_COLUMN)}) IN (${join(pairs, COMMA)})`;
}

/**
 * Locks the rows `keys` names. The table is read through its primary key, so every write takes its
 * locks in key order: given many keys, the optimizer would otherwise read through whichever index
 * it costs lowest.
 */
function Lock(target: WriteTarget, keys: readonly RowKey[]): Sql {
  const instance = QualifiedColumn(KEY_ALIAS, INSTANCE_COLUMN);
  const id = QualifiedColumn(KEY_ALIAS, ID_COLUMN);
  return sql`SELECT ${id} FROM ${ident(target.origin.plan.table)} AS ${ident(KEY_ALIAS)} FORCE INDEX (PRIMARY) WHERE ${Named(KEY_ALIAS, keys)} ORDER BY ${instance}, ${id} FOR UPDATE`;
}

/** The target narrowed to the rows `keys` names, which this transaction holds. */
function Held(
  target: WriteTarget,
  keys: readonly RowKey[],
  context: DecodingContext,
): WriteTarget {
  const alias = context.nextAlias();
  const relation = TableRelation(
    target.relation.dialect,
    ident(target.origin.plan.table),
    alias,
    target.origin,
  );
  relation.where.push(Named(alias, keys));
  relation.single = target.relation.single;
  return { ...target, relation, reach: "held" };
}

function Chunks(keys: readonly RowKey[]): RowKey[][] {
  const chunks: RowKey[][] = [];
  for (let start = 0; start < keys.length; start += KEYS_PER_STATEMENT) {
    chunks.push(keys.slice(start, start + KEYS_PER_STATEMENT));
  }
  return chunks;
}

/**
 * Runs a write whose read nests the table's block, in the transaction `connection` holds, and
 * answers the rows it counted.
 *
 * That block locks every row it reads, in the order its sort or index reads them, the rows the
 * outer blocks then leave out included. Two writes that sort the table two ways would lock their
 * rows in two orders, and deadlock past every retry. So the write reads which rows its read selects
 * without locking any, and locks them in key order. It reads the selection again once it holds
 * them, since a row another write changed meanwhile may have left it, and locks any row that came
 * in. It then writes the rows it holds that its read still selects, read by key, skipping any row
 * another transaction holds, which none of them is, so it waits on no other write.
 */
export async function OrderedWrite(
  target: WriteTarget,
  compile: (held: WriteTarget) => Sql,
  context: DecodingContext,
  connection: PoolConnection,
): Promise<number> {
  const locked = new Set<string>();
  let selected = await Selected(target, connection);
  for (let round = 0; round < LOCK_ROUNDS; round += 1) {
    const fresh = selected.filter((key) => !locked.has(Spelled(key)));
    if (fresh.length === 0) {
      break;
    }
    for (const chunk of Chunks(fresh)) {
      await Read(Lock(target, chunk), connection);
    }
    for (const key of fresh) {
      locked.add(Spelled(key));
    }
    selected = await Selected(target, connection);
  }
  const held = selected.filter((key) => locked.has(Spelled(key)));
  let written = 0;
  for (const chunk of Chunks(held)) {
    written += await Write(compile(Held(target, chunk, context)), connection);
  }
  return written;
}
