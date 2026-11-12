import type {
  CaptureSyntax,
  CapturedColumn,
  ChangeLogTables,
  ChangeOperation,
  PollRequest,
  TriggerBody,
} from "../capture";
import {
  Bind,
  MAX_IDENTIFIER_CHARS,
  type Sql,
  ident,
  int,
  join,
  lit,
  param,
  sql,
} from "../../statement";
import {
  BOOL,
  FLOAT,
  IsJsonBacked,
  OPAQUE,
  type SqlType,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";
import {
  INSTANCE_COLUMN,
  MAX_INSTANCE_ID_CHARS,
} from "../../implementations/database/utils";
import type { JsonSyntax } from "../sql-types";
import type { SqlSyntax } from "../types";
import type { Flavour } from "./flavour";

const COMMA = sql`, `;

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
const LOG_ID = ident("log_id");
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

/** How many characters of a log's identity the clock records. */
const LOG_ID_CHARS = 36;

/**
 * The identity of the log as it stands: a digest of the comment it was created with and of the
 * second the server last created or altered it in. A dump or a copy of its definition carries the
 * comment, but the server stamps the table it creates from one with a time of its own.
 */
function CurrentLogId(tables: ChangeLogTables): Sql {
  return sql`(SELECT LEFT(SHA2(CONCAT_WS(':', TABLE_COMMENT, UNIX_TIMESTAMP(CREATE_TIME)), 256), ${int(LOG_ID_CHARS)}) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${lit(tables.log)})`;
}

/**
 * The clock is seeded with `INSERT IGNORE`, which only reads the row it finds: an upsert would take
 * that row's lock shared and then exclusive, and two registrations doing so at once deadlock.
 *
 * The log carries an identity, from a comment chosen when the module creates it and the time the
 * server created it at, and the clock records the identity of the log it numbers. A log dropped and
 * created again has another, and the first bootstrap that sees it renews the epoch, once: the
 * update matches only while the two differ.
 */
function Bootstrap(
  flavour: Flavour,
  tables: ChangeLogTables,
  logId: string,
): readonly Sql[] {
  const options = sql`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=${lit(flavour.binaryCollation)}`;
  const log = [
    sql`${ID} BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`,
    sql`${SEQ} BIGINT UNSIGNED NULL`,
    sql`${SEQUENCED_AT} DATETIME(6) NULL`,
    sql`${TABLE} VARCHAR(${int(MAX_IDENTIFIER_CHARS)}) NOT NULL`,
    sql`${INSTANCE} VARCHAR(${int(MAX_INSTANCE_ID_CHARS)}) NOT NULL`,
    sql`${OPERATION} VARCHAR(${int(OPERATION_CHARS)}) NOT NULL`,
    sql`${ident(tables.oldImage)} ${flavour.jsonType} NULL`,
    sql`${ident(tables.newImage)} ${flavour.jsonType} NULL`,
    sql`PRIMARY KEY (${ID})`,
    sql`UNIQUE KEY ${SEQ} (${SEQ})`,
    sql`KEY ${ident("tbl_seq")} (${TABLE}, ${SEQ})`,
    sql`KEY ${SEQUENCED_AT} (${SEQUENCED_AT})`,
  ];
  const clock = [
    sql`${ID} TINYINT UNSIGNED NOT NULL`,
    sql`${NEXT_SEQ} BIGINT UNSIGNED NOT NULL`,
    sql`${EPOCH} CHAR(36) NOT NULL`,
    sql`${LOG_ID} CHAR(${int(LOG_ID_CHARS)}) NOT NULL`,
    sql`PRIMARY KEY (${ID})`,
  ];
  const reaped = [
    sql`${TABLE} VARCHAR(${int(MAX_IDENTIFIER_CHARS)}) NOT NULL`,
    sql`${HIGH_WATER} BIGINT UNSIGNED NOT NULL`,
    sql`PRIMARY KEY (${TABLE})`,
  ];
  const current = CurrentLogId(tables);
  return [
    sql`CREATE TABLE IF NOT EXISTS ${ident(tables.log)} (${join(log, COMMA)}) ${options} COMMENT = ${lit(logId)}`,
    sql`CREATE TABLE IF NOT EXISTS ${ident(tables.clock)} (${join(clock, COMMA)}) ${options}`,
    sql`CREATE TABLE IF NOT EXISTS ${ident(tables.reaped)} (${join(reaped, COMMA)}) ${options}`,
    sql`INSERT IGNORE INTO ${ident(tables.clock)} (${ID}, ${NEXT_SEQ}, ${EPOCH}, ${LOG_ID}) VALUES (${CLOCK_ROW}, 1, UUID(), ${current})`,
    sql`UPDATE ${ident(tables.clock)} SET ${EPOCH} = UUID(), ${LOG_ID} = ${current} WHERE ${ID} = ${CLOCK_ROW} AND ${LOG_ID} <> ${current}`,
  ];
}

/**
 * The deepest a JSON-backed column's value is boxed in its image: the image's object and the box
 * take two of the levels the engine stores, and `JSON_DEPTH` counts a level for the scalar inside
 * the deepest container, so a value of that depth nests no more containers than are left.
 */
const IMAGE_LEVELS = 2;

/**
 * A column as an image holds it. A scalar goes as the JSON value the compiler's own reading turns
 * back into it. A JSON-backed column is boxed in a one-element array, so a column holding SQL NULL
 * logs `null` and one holding a JSON null logs `[null]`. A value too deep for the box and the image
 * around it goes as its JSON text, a string, since the engine refuses to store a document past its
 * depth limit and the write that logs it would fail. Only such a value goes as text, because a feed
 * parses text back, and MySQL 8.4's parser reads some doubles of 17 significant digits as a
 * neighbour.
 */
function Imaged(engine: ImageSyntax, row: Sql, column: CapturedColumn): Sql {
  const { json } = engine;
  const value = sql`${row}.${ident(column.name)}`;
  if (IsJsonBacked(column.type)) {
    return sql`IF(JSON_DEPTH(${value}) <= ${int(engine.boxedDepth)}, JSON_ARRAY(${value}), ${json.of(json.text(value), "text")})`;
  }
  return json.of(value, column.type.kind);
}

/** What an image is written with: the JSON syntax, and the deepest value it boxes. */
interface ImageSyntax {
  readonly json: JsonSyntax;
  readonly boxedDepth: number;
}

function Image(
  engine: ImageSyntax,
  row: Sql,
  columns: readonly CapturedColumn[],
): Sql {
  const members = columns.map(
    (column) => sql`${lit(column.name)}, ${Imaged(engine, row, column)}`,
  );
  return sql`JSON_OBJECT(${join(members, COMMA)})`;
}

/** The key columns `_id` and `_instance`, text of a bounded width rather than a field's type. */
const BOUNDED_TEXT = /^varchar\(\d+\)$/;

/** Each type a stored field's column is created with, as the catalog spells it, and how it is logged. */
function LoggedTypes(syntax: SqlSyntax): ReadonlyMap<string, SqlType> {
  return new Map(
    [TEXT, FLOAT, BOOL, TIMESTAMP, OPAQUE].map((type) => [
      Bind(syntax.physical(type)).sql.toLowerCase(),
      type,
    ]),
  );
}

function LoggedType(
  logged: ReadonlyMap<string, SqlType>,
  columnType: string,
): SqlType | undefined {
  const spelled = columnType.toLowerCase();
  return BOUNDED_TEXT.test(spelled) ? TEXT : logged.get(spelled);
}

/** Set on a session whose updates move stored values without changing any document. */
const MOVING = sql`@antelopejs_moving`;

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
  image: ImageSyntax,
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
      body: sql`${head(newImage)} VALUES (${named}, ${instance(NEW)}, 'added', ${Image(image, NEW, columns)})`,
    },
    {
      operation: "modified",
      body: sql`IF ${MOVING} IS NULL AND NOT (${Unchanged(columns)}) THEN ${head(sql`${oldImage}, ${newImage}`)} VALUES (${named}, ${instance(NEW)}, 'modified', ${Image(image, OLD, columns)}, ${Image(image, NEW, columns)}); END IF`,
    },
    {
      operation: "removed",
      body: sql`${head(oldImage)} VALUES (${named}, ${instance(OLD)}, 'removed', ${Image(image, OLD, columns)})`,
    },
  ];
}

/** One polled side, read only where the log row holds that image: an insert has no old row. */
function Side(alias: Sql, image: string, statement: Sql): Sql {
  return sql`CASE WHEN ${alias}.${ident(image)} IS NOT NULL THEN (${statement}) END`;
}

/**
 * The clock's row, then the events up to its frontier. Where the engine has no lateral join, the
 * events read the frontier from the clock themselves, which one statement reads at one point.
 */
function Poll(
  flavour: Flavour,
  tables: ChangeLogTables,
  request: PollRequest,
): Sql {
  const ev = ident(request.alias);
  const table = param(request.table);
  const scope =
    request.instance === undefined
      ? sql``
      : sql` AND ${ev}.${INSTANCE} = ${param(request.instance)}`;
  const header = sql`SELECT k.${EPOCH} AS epoch, k.${NEXT_SEQ} - 1 AS frontier, (SELECT r.${HIGH_WATER} FROM ${ident(tables.reaped)} AS r WHERE r.${TABLE} = ${table}) AS high_water FROM ${ident(tables.clock)} AS k WHERE k.${ID} = ${CLOCK_ROW}`;
  const frontier = flavour.lateral
    ? sql`c.frontier`
    : sql`(SELECT f.${NEXT_SEQ} - 1 FROM ${ident(tables.clock)} AS f WHERE f.${ID} = ${CLOCK_ROW})`;
  const events = sql`SELECT ${ev}.${SEQ} AS seq, ${ev}.${OPERATION} AS op, ${Side(ev, tables.oldImage, request.old)} AS old_side, ${Side(ev, tables.newImage, request.new)} AS new_side FROM ${ident(tables.log)} AS ${ev} WHERE ${ev}.${TABLE} = ${table}${scope} AND ${ev}.${SEQ} > ${Seq(request.after)} AND ${ev}.${SEQ} <= ${frontier} ORDER BY ${ev}.${SEQ} LIMIT ${int(request.limit)}`;
  const join = flavour.lateral ? sql`LEFT JOIN LATERAL` : sql`LEFT JOIN`;
  return sql`SELECT c.epoch AS epoch, c.frontier AS frontier, c.high_water AS high_water, e.seq AS seq, e.op AS op, e.old_side AS old_side, e.new_side AS new_side FROM (${header}) AS c ${join} (${events}) AS e ON TRUE ORDER BY e.seq`;
}

/**
 * Numbers the rows in the order of `ids`. The rows are also named in the `WHERE`, so the server
 * reads them by key: MariaDB otherwise scans the log beside a `JSON_TABLE` of a bound list, and
 * waits on the row of a transaction still open, which the sequencer skipped.
 */
function Stamp(
  tables: ChangeLogTables,
  ids: readonly string[],
  first: bigint,
): Sql {
  const numbered = sql`JSON_TABLE(${param(JSON.stringify(ids))}, '$[*]' COLUMNS (n FOR ORDINALITY, id BIGINT UNSIGNED PATH '$')) AS v`;
  const named = join(
    ids.map((id) => sql`CAST(${param(id)} AS UNSIGNED)`),
    COMMA,
  );
  return sql`UPDATE ${ident(tables.log)} AS c JOIN ${numbered} ON c.${ID} = v.id SET c.${SEQ} = ${Seq(first)} + v.n - 1, c.${SEQUENCED_AT} = UTC_TIMESTAMP(6) WHERE c.${ID} IN (${named})`;
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

export function CaptureOf(flavour: Flavour, syntax: SqlSyntax): CaptureSyntax {
  const image: ImageSyntax = {
    json: syntax.json,
    boxedDepth: flavour.maxJsonNesting - IMAGE_LEVELS,
  };
  const { json } = syntax;
  const logged = LoggedTypes(syntax);
  return {
    bootstrap: (tables, logId) => Bootstrap(flavour, tables, logId),
    triggers: (tables, table, columns) =>
      Triggers(image, tables, table, columns),
    createTrigger: (name, table, trigger) =>
      sql`CREATE TRIGGER ${ident(name)} AFTER ${EVENTS[trigger.operation]} ON ${ident(table)} FOR EACH ROW ${trigger.body}`,
    dropTrigger: (name) => sql`DROP TRIGGER IF EXISTS ${ident(name)}`,
    triggerRefusal: TriggerRefusal,
    lockTable: (table) => sql`LOCK TABLES ${ident(table)} WRITE`,
    unlockTables: sql`UNLOCK TABLES`,
    markMoves: sql`SET ${MOVING} = 1`,
    unmarkMoves: sql`SET ${MOVING} = NULL`,
    loggedType: (columnType) => LoggedType(logged, columnType),
    unbox: (member) =>
      sql`(CASE WHEN ${json.is(member, ["array"])} THEN JSON_EXTRACT(${member}, '$[0]') WHEN ${json.is(member, ["string"])} THEN ${json.parse(sql`JSON_UNQUOTE(${member})`)} END)`,
    lockClock: (tables, wait) =>
      sql`SELECT ${NEXT_SEQ} AS next_seq, ${EPOCH} AS epoch FROM ${ident(tables.clock)} WHERE ${ID} = ${CLOCK_ROW} FOR UPDATE${wait ? sql`` : sql` SKIP LOCKED`}`,
    unsequenced: (tables, limit) =>
      sql`SELECT ${ID} AS id FROM ${ident(tables.log)} WHERE ${SEQ} IS NULL ORDER BY ${ID} LIMIT ${int(limit)}`,
    stamp: Stamp,
    advance: (tables, count) =>
      sql`UPDATE ${ident(tables.clock)} SET ${NEXT_SEQ} = ${NEXT_SEQ} + ${int(count)} WHERE ${ID} = ${CLOCK_ROW}`,
    frontier: (tables) =>
      sql`SELECT ${EPOCH} AS epoch, ${NEXT_SEQ} - 1 AS frontier, EXISTS (SELECT 1 FROM ${ident(tables.log)} WHERE ${SEQ} IS NULL) AS pending FROM ${ident(tables.clock)} WHERE ${ID} = ${CLOCK_ROW}`,
    changedTables: (tables, after) =>
      sql`SELECT DISTINCT ${TABLE} AS tbl FROM ${ident(tables.log)} WHERE ${SEQ} > ${Seq(after)}`,
    poll: (tables, request) => Poll(flavour, tables, request),
    reapThrough: (tables, retentionMs, limit) =>
      sql`SELECT MAX(b.${SEQ}) AS through FROM (SELECT ${SEQ} FROM ${ident(tables.log)} WHERE ${SEQUENCED_AT} < UTC_TIMESTAMP(6) - INTERVAL ${int(retentionMs * MICROSECONDS_PER_MS)} MICROSECOND ORDER BY ${SEQUENCED_AT} LIMIT ${int(limit)}) AS b`,
    raiseReaped: (tables, through) => {
      const reaped = ident(tables.reaped);
      return sql`INSERT INTO ${reaped} (${TABLE}, ${HIGH_WATER}) SELECT d.${TABLE}, d.${HIGH_WATER} FROM (SELECT ${TABLE}, MAX(${SEQ}) AS ${HIGH_WATER} FROM ${ident(tables.log)} WHERE ${SEQ} <= ${Seq(through)} GROUP BY ${TABLE}) AS d ON DUPLICATE KEY UPDATE ${HIGH_WATER} = GREATEST(${reaped}.${HIGH_WATER}, d.${HIGH_WATER})`;
    },
    reap: (tables, through) =>
      sql`DELETE FROM ${ident(tables.log)} WHERE ${SEQ} <= ${Seq(through)}`,
  };
}
