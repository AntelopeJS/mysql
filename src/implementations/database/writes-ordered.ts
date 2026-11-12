import assert from "node:assert";
import type { PoolConnection } from "mysql2/promise";

import { Read, type Row, Write } from "../../connection";
import type { ListedColumn } from "../../dialect/sql-types";
import { type Sql, ident, join, param, sql } from "../../statement";
import type { DecodingContext } from "./context";
import { IsString } from "./guards";
import { TableRelation } from "./relation";
import { JoinOn, Render } from "./render";
import { QualifiedColumn } from "./sql";
import {
  ID_COLUMN,
  INSTANCE_COLUMN,
  MAX_INSTANCE_ID_CHARS,
  MAX_KEY_CHARS,
} from "./utils";
import type { WriteTarget } from "./writes-shared";

/** One row's primary key, in the order the key declares its columns. */
interface RowKey {
  readonly instance: string;
  readonly id: string;
}

/**
 * The rows one locking read names by key: two bound values each, of the 65,535 a statement takes.
 * The reads run in key order, so the rows are locked in key order all the same.
 */
const KEYS_PER_LOCK = 1000;

const COMMA = sql`, `;
const AND = sql` AND `;

/** The alias the reads here give the table or the selection, apart from every `t`-numbered one. */
const KEY_ALIAS = "k";

const INSTANCE_KEY = "i";
const ID_KEY = "d";

/** The key columns a held write lists its rows by, each as wide as the table's own. */
const KEY_COLUMNS: readonly ListedColumn[] = [
  { name: INSTANCE_KEY, chars: MAX_INSTANCE_ID_CHARS },
  { name: ID_KEY, chars: MAX_KEY_CHARS },
];

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

/**
 * Locks the rows `keys` names. The table is read through its primary key, so every write takes its
 * locks in key order: given many keys, the optimizer would otherwise read through whichever index
 * it costs lowest.
 */
function Lock(target: WriteTarget, keys: readonly RowKey[]): Sql {
  const instance = QualifiedColumn(KEY_ALIAS, INSTANCE_COLUMN);
  const id = QualifiedColumn(KEY_ALIAS, ID_COLUMN);
  const pairs = keys.map(
    (key) => sql`(${param(key.instance)}, ${param(key.id)})`,
  );
  return sql`SELECT ${id} FROM ${ident(target.origin.plan.table)} AS ${ident(KEY_ALIAS)} FORCE INDEX (PRIMARY) WHERE (${instance}, ${id}) IN (${join(pairs, COMMA)}) ORDER BY ${instance}, ${id} FOR UPDATE`;
}

function Chunks(keys: readonly RowKey[]): RowKey[][] {
  const chunks: RowKey[][] = [];
  for (let start = 0; start < keys.length; start += KEYS_PER_LOCK) {
    chunks.push(keys.slice(start, start + KEYS_PER_LOCK));
  }
  return chunks;
}

/**
 * Locks the rows the target's read selects, in key order, and answers their keys once this
 * transaction holds every row its read selects.
 *
 * Each round reads the selection without locking any row and locks the rows of it that no earlier
 * round named. A row another write moves into the selection meanwhile is in the next read, so the
 * rounds end only at a read naming no row outside the held ones. The write then holds its whole
 * selection, which no other write can change before it commits. Every round before that one names
 * a key no earlier round named, and no lock is released before the commit, so the rounds number at
 * most one more than the keys the table holds while the write runs.
 */
async function HeldSelection(
  target: WriteTarget,
  connection: PoolConnection,
): Promise<RowKey[]> {
  const named = new Set<string>();
  let selected = await Selected(target, connection);
  let fresh = selected;
  while (fresh.length > 0) {
    for (const chunk of Chunks(fresh)) {
      await Read(Lock(target, chunk), connection);
    }
    for (const key of fresh) {
      named.add(Spelled(key));
    }
    selected = await Selected(target, connection);
    fresh = selected.filter((key) => !named.has(Spelled(key)));
  }
  return selected;
}

/**
 * The target narrowed to the rows `keys` names, which this transaction holds. The keys are joined as
 * one bound list, so one statement writes them however many there are.
 */
function Held(
  target: WriteTarget,
  keys: readonly RowKey[],
  context: DecodingContext,
): WriteTarget {
  const dialect = target.relation.dialect;
  const alias = context.nextAlias();
  const listed = context.nextAlias();
  const relation = TableRelation(
    dialect,
    ident(target.origin.plan.table),
    alias,
    target.origin,
  );
  const on = [
    sql`${QualifiedColumn(alias, INSTANCE_COLUMN)} = ${QualifiedColumn(listed, INSTANCE_KEY)}`,
    sql`${QualifiedColumn(alias, ID_COLUMN)} = ${QualifiedColumn(listed, ID_KEY)}`,
  ];
  const rows = keys.map((key) => [key.instance, key.id]);
  relation.joins.push(
    JoinOn(
      "JOIN",
      dialect.sql.rows.listed(rows, KEY_COLUMNS),
      listed,
      join(on, AND),
    ),
  );
  relation.single = target.relation.single;
  return { ...target, relation, reach: "held" };
}

/**
 * Runs a write whose read nests the table's block, in the transaction `connection` holds, and
 * answers the rows it counted.
 *
 * That block locks every row it reads, in the order its sort or index reads them, the rows the
 * outer blocks then leave out included. Two writes that sort the table two ways would lock their
 * rows in two orders, and deadlock past every retry. So the write first holds every row its read
 * selects, locked in key order as {@link HeldSelection} does. It then writes them in one statement
 * that reads them by key, skipping any row another transaction holds, which none of them is, so it
 * waits on no other write. A value that statement computes from other rows reads them as they were
 * before it, as the same write through one block would.
 */
export async function OrderedWrite(
  target: WriteTarget,
  compile: (held: WriteTarget) => Sql,
  context: DecodingContext,
  connection: PoolConnection,
): Promise<number> {
  const held = await HeldSelection(target, connection);
  if (held.length === 0) {
    return 0;
  }
  return Write(compile(Held(target, held, context)), connection);
}
