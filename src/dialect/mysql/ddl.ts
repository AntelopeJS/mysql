import type { DdlFailure, DdlSyntax, InstancesTable, RowKey } from "../ddl";
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
import {
  type KeyColumn,
  KeyColumnsOf,
  type KeyPart,
} from "../../implementations/database/paths";
import type {
  DeclaredColumn,
  IndexPlan,
  TablePlan,
} from "../../implementations/database/plan";
import type { SqlType } from "../../implementations/database/types";
import {
  EXTRA_COLUMN,
  ID_COLUMN,
  INSTANCE_COLUMN,
  MAX_INSTANCE_ID_CHARS,
} from "../../implementations/database/utils";
import { session } from "./session";
import { sqlCore } from "./sql-core";
import { json } from "./sql-json";
import { scalar } from "./sql-scalar";

/**
 * The widest element a multi-valued index holds, in characters: the largest `CHAR(N) ARRAY` the
 * server accepts. A longer element fails its write, as an index entry over the key limit would.
 */
const ELEMENT_CHARS = 512;

/** An ISO-8601 UTC instant as `Date.prototype.toJSON` writes one, every field in its range. */
const ISO_INSTANT =
  "^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]{1,6})?Z$";

const FAILURES = new Map<number, DdlFailure>([
  [1050, "present"],
  [1060, "present"],
  [1061, "present"],
  [1091, "absent"],
  [1205, "lockTimeout"],
  [1213, "lockTimeout"],
  [1317, "interrupted"],
]);

const ROW_KEY = sql`${ident(INSTANCE_COLUMN)}, ${ident(ID_COLUMN)}`;

function JsonPath(path: readonly string[]): Sql {
  return lit(`$${path.map((key) => `.${JSON.stringify(key)}`).join("")}`);
}

/**
 * Whether the JSON value is of one of `types`. The type name is compared as bytes: `JSON_TYPE`
 * answers in `utf8mb4_bin`, which a literal in the session's collation cannot be compared with.
 */
function JsonTypeIn(value: Sql, types: Sql): Sql {
  return sql`CAST(JSON_TYPE(${value}) AS BINARY) IN (${types})`;
}

/** The JSON string at `value` as text; NULL for any other JSON type. */
function StringOf(value: Sql): Sql {
  return sql`IF(${JsonTypeIn(value, sql`'STRING'`)}, JSON_UNQUOTE(${value}), NULL)`;
}

/** The JSON number at `value`; NULL for any other JSON type. */
function NumberOf(value: Sql): Sql {
  const numbers = sql`'INTEGER', 'UNSIGNED INTEGER', 'DOUBLE', 'DECIMAL'`;
  return sql`IF(${JsonTypeIn(value, numbers)}, CAST(${value} AS DOUBLE), NULL)`;
}

/** The JSON boolean at `value` as 1 or 0; NULL for any other JSON type. */
function BooleanOf(value: Sql): Sql {
  return sql`IF(${JsonTypeIn(value, sql`'BOOLEAN'`)}, ${value} = CAST('true' AS JSON), NULL)`;
}

/**
 * The instant an ISO-8601 UTC JSON string at `value` names; NULL for anything else. Each check is
 * its own `IF`, which evaluates only the branch it takes: a strict-mode `UPDATE` fails outright on a
 * date function given a day its month does not have, such as February 30.
 */
function InstantOf(value: Sql): Sql {
  const text = sql`(JSON_UNQUOTE(${value}) COLLATE ${lit(session.binaryCollation)})`;
  const day = sql`CAST(SUBSTRING(${text}, 9, 2) AS UNSIGNED)`;
  const lastDay = sql`DAYOFMONTH(LAST_DAY(CONCAT(SUBSTRING(${text}, 1, 8), '01')))`;
  const instant = sql`CAST(REPLACE(REPLACE(${text}, 'T', ' '), 'Z', '') AS DATETIME(6))`;
  const valid = sql`IF(${day} <= ${lastDay}, ${instant}, NULL)`;
  const written = sql`IF(${text} REGEXP ${lit(ISO_INSTANT)}, ${valid}, NULL)`;
  return sql`IF(${JsonTypeIn(value, sql`'STRING'`)}, ${written}, NULL)`;
}

/** Any JSON value but JSON null, which stays in `_extra` so it keeps reading as an explicit null. */
function DocumentOf(value: Sql): Sql {
  return sql`IF(${JsonTypeIn(value, sql`'NULL'`)}, NULL, ${value})`;
}

/** How a JSON value becomes a value of each declared type, NULL where it cannot. */
const REPRESENTATIONS: Record<SqlType["kind"], (value: Sql) => Sql> = {
  text: StringOf,
  float: NumberOf,
  bool: BooleanOf,
  timestamp: InstantOf,
  json: DocumentOf,
  array: DocumentOf,
};

function KeyType(key: KeyColumn): Sql {
  switch (key.read) {
    case "double":
    case "ranked-number":
      return sql`DOUBLE`;
    case "bool":
      return sql`TINYINT(1)`;
    default:
      return sql`VARCHAR(${int(key.fit.width)})`;
  }
}

/**
 * What a key column holds, as the generation expression the server evaluates per row. Its read is
 * the member the compiler reads the same value through, so the two cannot drift apart.
 *
 * The expression is not part of the column's signature, which names only what the column holds, so
 * a column whose expression reads the same path another way, one key at a time, is kept: it holds
 * the same value on every row.
 */
function KeyExpression(key: KeyColumn): Sql {
  const value = json.key(key.read, json.member(ident(key.source), ...key.path));
  return "fit" in key && key.fit.kind === "prefix"
    ? scalar.left(value, key.fit.width)
    : value;
}

function KeyColumnDefinition(key: KeyColumn): Sql {
  return sql`${ident(key.name)} ${KeyType(key)} GENERATED ALWAYS AS (${KeyExpression(key)}) VIRTUAL COMMENT ${lit(key.definition)}`;
}

function DeclaredDefinition(column: DeclaredColumn, comment: string): Sql {
  return sql`${ident(column.name)} ${sqlCore.physical(column.type)} NULL COMMENT ${lit(comment)}`;
}

function ColumnDefinition(column: TablePlan["columns"][number]): Sql {
  switch (column.role) {
    case "id":
    case "instance":
      return sql`${ident(column.name)} VARCHAR(${int(column.chars)}) NOT NULL`;
    case "extra":
      return sql`${ident(column.name)} JSON NOT NULL DEFAULT (JSON_OBJECT())`;
    case "declared":
      return DeclaredDefinition(column, "");
  }
}

function IndexPart(part: KeyPart): Sql {
  switch (part.kind) {
    case "instance":
    case "stored":
      return ident(part.column);
    case "key":
    case "value":
      return join(
        KeyColumnsOf(part).map((key) => ident(key.name)),
        sql`, `,
      );
    case "elements":
      return sql`(CAST(${json.indexedElements(ident(part.column))} AS CHAR(${int(ELEMENT_CHARS)}) ARRAY))`;
  }
}

function IsMultiValued(index: IndexPlan): boolean {
  return index.parts.some((part) => part.kind === "elements");
}

function IndexDefinition(index: IndexPlan): Sql {
  const kind = index.unique ? sql`UNIQUE INDEX` : sql`INDEX`;
  const parts = join(index.parts.map(IndexPart), sql`, `);
  return sql`${kind} ${ident(index.name)} (${parts}) COMMENT ${lit(index.signature)}`;
}

/**
 * Writes keep flowing while a btree index builds. A multi-valued index cannot be built that way on
 * MySQL 8.4 or 9.7, which answer 1846 to `LOCK=NONE`; it blocks writes while it builds instead.
 */
function Online(index: IndexPlan): Sql {
  return IsMultiValued(index)
    ? sql`LOCK=SHARED`
    : sql`ALGORITHM=INPLACE, LOCK=NONE`;
}

const TABLE_OPTIONS = sql`ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=${lit(session.binaryCollation)}`;

function CreateTable(plan: TablePlan, comment: string): Sql {
  const definitions = [
    ...plan.columns.map(ColumnDefinition),
    ...plan.keyColumns.map(KeyColumnDefinition),
    sql`PRIMARY KEY (${ROW_KEY})`,
    ...plan.indexes.map(IndexDefinition),
  ];
  return sql`CREATE TABLE ${ident(plan.table)} (${join(definitions, sql`, `)}) ${TABLE_OPTIONS} COMMENT=${lit(comment)}`;
}

/** Rows strictly after `after` in key order; every row when there is none. */
function After(after: RowKey | undefined): Sql {
  if (!after) {
    return sql`TRUE`;
  }
  const instance = ident(INSTANCE_COLUMN);
  return sql`(${instance} > ${param(after.instance)} OR (${instance} = ${param(after.instance)} AND ${ident(ID_COLUMN)} > ${param(after.id)}))`;
}

/** Rows up to `through` in key order, inclusive; every row when there is none. */
function Through(through: RowKey | undefined): Sql {
  if (!through) {
    return sql`TRUE`;
  }
  const instance = ident(INSTANCE_COLUMN);
  return sql`(${instance} < ${param(through.instance)} OR (${instance} = ${param(through.instance)} AND ${ident(ID_COLUMN)} <= ${param(through.id)}))`;
}

function BackfillBound(
  table: string,
  after: RowKey | undefined,
  rows: number,
): Sql {
  return sql`SELECT ${ident(INSTANCE_COLUMN)} AS instance, ${ident(ID_COLUMN)} AS id FROM ${ident(table)} WHERE ${After(after)} ORDER BY ${ROW_KEY} LIMIT 1 OFFSET ${int(rows - 1)}`;
}

function BackfillChunk(
  table: string,
  column: DeclaredColumn,
  after: RowKey | undefined,
  through: RowKey | undefined,
): Sql {
  const extra = ident(EXTRA_COLUMN);
  const key = JsonPath([column.field]);
  const value = REPRESENTATIONS[column.type.kind](
    sql`JSON_EXTRACT(${extra}, ${key})`,
  );
  const target = ident(column.name);
  return sql`UPDATE ${ident(table)} SET ${target} = ${value}, ${extra} = JSON_REMOVE(${extra}, ${key}) WHERE ${target} IS NULL AND ${value} IS NOT NULL AND ${After(after)} AND ${Through(through)}`;
}

function DropColumns(
  table: string,
  columns: readonly string[],
  indexes: readonly string[],
): Sql {
  const drops = [
    ...indexes.map((name) => sql`DROP INDEX ${ident(name)}`),
    ...columns.map((name) => sql`DROP COLUMN ${ident(name)}`),
  ];
  return sql`ALTER TABLE ${ident(table)} ${join(drops, sql`, `)}`;
}

function CreateInstances(registry: InstancesTable): Sql {
  const schema = ident(registry.schema);
  const instance = ident(registry.instance);
  const columns = [
    sql`${schema} VARCHAR(${int(MAX_IDENTIFIER_CHARS)}) NOT NULL`,
    sql`${instance} VARCHAR(${int(MAX_INSTANCE_ID_CHARS)}) NOT NULL`,
    sql`${ident(registry.created)} DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`,
    sql`PRIMARY KEY (${schema}, ${instance})`,
  ];
  return sql`CREATE TABLE IF NOT EXISTS ${ident(registry.table)} (${join(columns, sql`, `)}) ${TABLE_OPTIONS}`;
}

/** A server error has a positive `errno`; a driver error that ended the connection is `fatal`. */
function Failure(error: Error): DdlFailure {
  const errno = "errno" in error ? Number(error.errno) : 0;
  const fatal = "fatal" in error && error.fatal === true;
  if (fatal || !Number.isInteger(errno) || errno <= 0) {
    return "broken";
  }
  return FAILURES.get(errno) ?? "refused";
}

export const ddl: DdlSyntax = {
  createTable: CreateTable,
  addColumn: (table, column, comment) =>
    sql`ALTER TABLE ${ident(table)} ADD COLUMN ${DeclaredDefinition(column, comment)}`,
  modifyColumn: (table, column, comment) =>
    sql`ALTER TABLE ${ident(table)} MODIFY COLUMN ${DeclaredDefinition(column, comment)}`,
  addKeyColumn: (table, key) =>
    sql`ALTER TABLE ${ident(table)} ADD COLUMN ${KeyColumnDefinition(key)}`,
  dropColumns: DropColumns,
  addIndex: (table, index) =>
    sql`ALTER TABLE ${ident(table)} ADD ${IndexDefinition(index)}, ${Online(index)}`,
  swapIndex: (table, index) =>
    sql`ALTER TABLE ${ident(table)} DROP INDEX ${ident(index.name)}, ADD ${IndexDefinition(index)}, ${Online(index)}`,
  dropIndex: (table, name) =>
    sql`ALTER TABLE ${ident(table)} DROP INDEX ${ident(name)}, ALGORITHM=INPLACE, LOCK=NONE`,
  backfillBound: BackfillBound,
  backfillChunk: BackfillChunk,
  lockWait: (seconds) =>
    seconds === undefined
      ? sql`SET SESSION lock_wait_timeout = DEFAULT`
      : sql`SET SESSION lock_wait_timeout = ${int(seconds)}`,
  killQuery: (connectionId) => sql`KILL QUERY ${int(connectionId)}`,
  createInstances: CreateInstances,
  failure: Failure,
};
