import type {
  CaptureSyntax,
  CapturedColumn,
  ChangeLogTables,
  ChangeOperation,
  PollRequest,
  TriggerBody,
} from "../capture";
import {
  MAX_IDENTIFIER_CHARS,
  type Sql,
  ident,
  int,
  join,
  lit,
  param,
  sql,
} from "../../statement";
import { IsJsonBacked } from "../../implementations/database/types";
import {
  INSTANCE_COLUMN,
  MAX_INSTANCE_ID_CHARS,
} from "../../implementations/database/utils";
import { session } from "./session";
import { json } from "./sql-json";

const COMMA = sql`, `;

const TABLE_OPTIONS = sql`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=${lit(session.binaryCollation)}`;

/** The one row of the clock. */
const CLOCK_ROW = sql`1`;

/** The widest operation name the log stores. */
const OPERATION_CHARS = 8;

const ID = ident("id");
const SEQ = ident("seq");
const SEQUENCED_AT = ident("sequenced_at");
const TABLE = ident("tbl");
const INSTANCE = ident("inst");
const OPERATION = ident("op");
const NEXT_SEQ = ident("next_seq");
const EPOCH = ident("epoch");
const HIGH_WATER = ident("high_water");

const EVENTS: Record<ChangeOperation, Sql> = {
  added: sql`INSERT`,
  modified: sql`UPDATE`,
  removed: sql`DELETE`,
};

/** A `seq` bound as text and read as the unsigned integer the column holds, so its index serves it. */
function Seq(value: bigint): Sql {
  return sql`CAST(${param(value.toString())} AS UNSIGNED)`;
}

/**
 * The clock is seeded with `INSERT IGNORE`, which only reads the row it finds: an upsert would take
 * that row's lock shared and then exclusive, and two registrations doing so at once deadlock.
 */
function Bootstrap(tables: ChangeLogTables): readonly Sql[] {
  const log = [
    sql`${ID} BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`,
    sql`${SEQ} BIGINT UNSIGNED NULL`,
    sql`${SEQUENCED_AT} DATETIME(6) NULL`,
    sql`${TABLE} VARCHAR(${int(MAX_IDENTIFIER_CHARS)}) NOT NULL`,
    sql`${INSTANCE} VARCHAR(${int(MAX_INSTANCE_ID_CHARS)}) NOT NULL`,
    sql`${OPERATION} VARCHAR(${int(OPERATION_CHARS)}) NOT NULL`,
    sql`${ident(tables.oldImage)} JSON NULL`,
    sql`${ident(tables.newImage)} JSON NULL`,
    sql`PRIMARY KEY (${ID})`,
    sql`UNIQUE KEY ${SEQ} (${SEQ})`,
    sql`KEY ${ident("tbl_seq")} (${TABLE}, ${SEQ})`,
    sql`KEY ${SEQUENCED_AT} (${SEQUENCED_AT})`,
  ];
  const clock = [
    sql`${ID} TINYINT UNSIGNED NOT NULL`,
    sql`${NEXT_SEQ} BIGINT UNSIGNED NOT NULL`,
    sql`${EPOCH} CHAR(36) NOT NULL`,
    sql`PRIMARY KEY (${ID})`,
  ];
  const reaped = [
    sql`${TABLE} VARCHAR(${int(MAX_IDENTIFIER_CHARS)}) NOT NULL`,
    sql`${HIGH_WATER} BIGINT UNSIGNED NOT NULL`,
    sql`PRIMARY KEY (${TABLE})`,
  ];
  return [
    sql`CREATE TABLE IF NOT EXISTS ${ident(tables.log)} (${join(log, COMMA)}) ${TABLE_OPTIONS}`,
    sql`CREATE TABLE IF NOT EXISTS ${ident(tables.clock)} (${join(clock, COMMA)}) ${TABLE_OPTIONS}`,
    sql`CREATE TABLE IF NOT EXISTS ${ident(tables.reaped)} (${join(reaped, COMMA)}) ${TABLE_OPTIONS}`,
    sql`INSERT IGNORE INTO ${ident(tables.clock)} (${ID}, ${NEXT_SEQ}, ${EPOCH}) VALUES (${CLOCK_ROW}, 1, UUID())`,
  ];
}

/**
 * A column as an image holds it. A scalar goes as the JSON value the compiler's own reading turns
 * back into it. A JSON-backed column goes as its JSON text, a string, so a column holding SQL NULL
 * logs `null` and one holding a JSON null logs `"null"`. Logged as a value, it would nest one level
 * deeper in the image than in its column, and MySQL refuses to store a document past its depth
 * limit, so a value the column holds would fail the write that logs it.
 */
function Imaged(row: Sql, column: CapturedColumn): Sql {
  const value = sql`${row}.${ident(column.name)}`;
  if (IsJsonBacked(column.type)) {
    return json.text(value);
  }
  return json.of(value, column.type.kind);
}

function Image(row: Sql, columns: readonly CapturedColumn[]): Sql {
  const members = columns.map(
    (column) => sql`${lit(column.name)}, ${Imaged(row, column)}`,
  );
  return sql`JSON_OBJECT(${join(members, COMMA)})`;
}

const OLD = sql`OLD`;
const NEW = sql`NEW`;

function Unchanged(columns: readonly CapturedColumn[]): Sql {
  const same = columns.map(
    (column) =>
      sql`${OLD}.${ident(column.name)} <=> ${NEW}.${ident(column.name)}`,
  );
  return join(same, sql` AND `);
}

function Triggers(
  tables: ChangeLogTables,
  table: string,
  columns: readonly CapturedColumn[],
): readonly TriggerBody[] {
  const log = ident(tables.log);
  const named = lit(table);
  const instance = (row: Sql) => sql`${row}.${ident(INSTANCE_COLUMN)}`;
  const oldImage = ident(tables.oldImage);
  const newImage = ident(tables.newImage);
  const head = (images: Sql) =>
    sql`INSERT INTO ${log} (${TABLE}, ${INSTANCE}, ${OPERATION}, ${images})`;
  return [
    {
      operation: "added",
      body: sql`${head(newImage)} VALUES (${named}, ${instance(NEW)}, 'added', ${Image(NEW, columns)})`,
    },
    {
      operation: "modified",
      body: sql`IF NOT (${Unchanged(columns)}) THEN ${head(sql`${oldImage}, ${newImage}`)} VALUES (${named}, ${instance(NEW)}, 'modified', ${Image(OLD, columns)}, ${Image(NEW, columns)}); END IF`,
    },
    {
      operation: "removed",
      body: sql`${head(oldImage)} VALUES (${named}, ${instance(OLD)}, 'removed', ${Image(OLD, columns)})`,
    },
  ];
}

/** One polled side, read only where the log row holds that image: an insert has no old row. */
function Side(alias: Sql, image: string, statement: Sql): Sql {
  return sql`CASE WHEN ${alias}.${ident(image)} IS NOT NULL THEN (${statement}) END`;
}

function Poll(tables: ChangeLogTables, request: PollRequest): Sql {
  const ev = ident(request.alias);
  const table = param(request.table);
  const scope =
    request.instance === undefined
      ? sql``
      : sql` AND ${ev}.${INSTANCE} = ${param(request.instance)}`;
  const header = sql`SELECT k.${EPOCH} AS epoch, k.${NEXT_SEQ} - 1 AS frontier, (SELECT r.${HIGH_WATER} FROM ${ident(tables.reaped)} AS r WHERE r.${TABLE} = ${table}) AS high_water FROM ${ident(tables.clock)} AS k WHERE k.${ID} = ${CLOCK_ROW}`;
  const events = sql`SELECT ${ev}.${SEQ} AS seq, ${ev}.${OPERATION} AS op, ${Side(ev, tables.oldImage, request.old)} AS old_side, ${Side(ev, tables.newImage, request.new)} AS new_side FROM ${ident(tables.log)} AS ${ev} WHERE ${ev}.${TABLE} = ${table}${scope} AND ${ev}.${SEQ} > ${Seq(request.after)} AND ${ev}.${SEQ} <= c.frontier ORDER BY ${ev}.${SEQ} LIMIT ${int(request.limit)}`;
  return sql`SELECT c.epoch AS epoch, c.frontier AS frontier, c.high_water AS high_water, e.seq AS seq, e.op AS op, e.old_side AS old_side, e.new_side AS new_side FROM (${header}) AS c LEFT JOIN LATERAL (${events}) AS e ON TRUE ORDER BY e.seq`;
}

/** `You do not have the SUPER privilege and binary logging is enabled`, raised by `CREATE TRIGGER`. */
const BINARY_LOG_REFUSAL = 1419;

const TRIGGER_REFUSAL = `A change feed needs row triggers on the table, and MySQL refused to create one (errno ${BINARY_LOG_REFUSAL}): the server has binary logging on, which lets only an account with the SUPER privilege create a trigger unless log_bin_trust_function_creators is 1. Either grant the account in the configured url that privilege (GRANT SUPER ON *.* TO the account), or set the variable on the server (SET GLOBAL log_bin_trust_function_creators = 1, and in its configuration file to keep it across a restart). See https://dev.mysql.com/doc/refman/8.4/en/stored-programs-logging.html`;

function TriggerRefusal(error: Error): string | undefined {
  const refused = "errno" in error && error.errno === BINARY_LOG_REFUSAL;
  return refused ? TRIGGER_REFUSAL : undefined;
}

/** Microseconds in a millisecond, which `INTERVAL` takes the retention in. */
const MICROSECONDS_PER_MS = 1000;

export const capture: CaptureSyntax = {
  bootstrap: Bootstrap,
  triggers: Triggers,
  createTrigger: (name, table, trigger) =>
    sql`CREATE TRIGGER ${ident(name)} AFTER ${EVENTS[trigger.operation]} ON ${ident(table)} FOR EACH ROW ${trigger.body}`,
  dropTrigger: (name) => sql`DROP TRIGGER IF EXISTS ${ident(name)}`,
  triggerRefusal: TriggerRefusal,
  lockTable: (table) => sql`LOCK TABLES ${ident(table)} WRITE`,
  unlockTables: sql`UNLOCK TABLES`,
  unbox: (member) =>
    sql`(CASE WHEN ${json.is(member, ["string"])} THEN ${json.parse(sql`JSON_UNQUOTE(${member})`)} END)`,
  lockClock: (tables, wait) =>
    sql`SELECT ${NEXT_SEQ} AS next_seq, ${EPOCH} AS epoch FROM ${ident(tables.clock)} WHERE ${ID} = ${CLOCK_ROW} FOR UPDATE${wait ? sql`` : sql` SKIP LOCKED`}`,
  unsequenced: (tables, limit) =>
    sql`SELECT ${ID} AS id FROM ${ident(tables.log)} WHERE ${SEQ} IS NULL ORDER BY ${ID} LIMIT ${int(limit)} FOR UPDATE SKIP LOCKED`,
  stamp: (tables, ids, first) =>
    sql`UPDATE ${ident(tables.log)} AS c JOIN JSON_TABLE(${param(JSON.stringify(ids))}, '$[*]' COLUMNS (n FOR ORDINALITY, id BIGINT UNSIGNED PATH '$')) AS v ON c.${ID} = v.id SET c.${SEQ} = ${Seq(first)} + v.n - 1, c.${SEQUENCED_AT} = UTC_TIMESTAMP(6)`,
  advance: (tables, count) =>
    sql`UPDATE ${ident(tables.clock)} SET ${NEXT_SEQ} = ${NEXT_SEQ} + ${int(count)} WHERE ${ID} = ${CLOCK_ROW}`,
  frontier: (tables) =>
    sql`SELECT ${EPOCH} AS epoch, ${NEXT_SEQ} - 1 AS frontier, EXISTS (SELECT 1 FROM ${ident(tables.log)} WHERE ${SEQ} IS NULL) AS pending FROM ${ident(tables.clock)} WHERE ${ID} = ${CLOCK_ROW}`,
  changedTables: (tables, after) =>
    sql`SELECT DISTINCT ${TABLE} AS tbl FROM ${ident(tables.log)} WHERE ${SEQ} > ${Seq(after)}`,
  poll: Poll,
  reapThrough: (tables, retentionMs, limit) =>
    sql`SELECT MAX(b.${SEQ}) AS through FROM (SELECT ${SEQ} FROM ${ident(tables.log)} WHERE ${SEQUENCED_AT} < UTC_TIMESTAMP(6) - INTERVAL ${int(retentionMs * MICROSECONDS_PER_MS)} MICROSECOND ORDER BY ${SEQUENCED_AT} LIMIT ${int(limit)}) AS b`,
  raiseReaped: (tables, through) => {
    const reaped = ident(tables.reaped);
    return sql`INSERT INTO ${reaped} (${TABLE}, ${HIGH_WATER}) SELECT d.${TABLE}, d.${HIGH_WATER} FROM (SELECT ${TABLE}, MAX(${SEQ}) AS ${HIGH_WATER} FROM ${ident(tables.log)} WHERE ${SEQ} <= ${Seq(through)} GROUP BY ${TABLE}) AS d ON DUPLICATE KEY UPDATE ${HIGH_WATER} = GREATEST(${reaped}.${HIGH_WATER}, d.${HIGH_WATER})`;
  },
  reap: (tables, through) =>
    sql`DELETE FROM ${ident(tables.log)} WHERE ${SEQ} <= ${Seq(through)}`,
};
