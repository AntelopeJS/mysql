import type { Row } from "../../connection";
import { type Sql, ident, join, param, sql } from "../../statement";
import type {
  CatalogColumn,
  CatalogIndex,
  ExternalCatalogSyntax,
  ExternalRelationKind,
  ReferenceRow,
  RelationRow,
} from "../external";
import type { Flavour } from "./flavour";

const BASE_TABLE = "BASE TABLE";
const PARTITIONED = "partitioned";
const PRIMARY = "PRIMARY";
const VISIBLE = "YES";
const NULLABLE = "YES";
const VIEW_COMMENT = "VIEW";
const DEFAULT_GENERATED = "DEFAULT_GENERATED";
const GENERATED = /\b(VIRTUAL|STORED) GENERATED\b/i;
const AUTO_INCREMENT = /\bauto_increment\b/i;
const ENUM_LABEL = /'((?:[^']|'')*)'/g;
const USER_SEPARATOR = "@";

/**
 * The account the connection runs as, spelled as the privilege views spell a grantee. Roles are
 * not resolved: a privilege granted only through a role is not seen here.
 */
const GRANTEE = sql`CONCAT('''', SUBSTRING_INDEX(CURRENT_USER(), '@', 1), '''@''', SUBSTRING_INDEX(CURRENT_USER(), '@', -1), '''')`;

const SYSTEM_SCHEMAS = sql`('mysql', 'information_schema', 'performance_schema', 'sys')`;

/** Whether the account holds `privilege` on the relation `t` names: globally, on its schema, or on it. */
function Privilege(privilege: string): Sql {
  const name = param(privilege);
  return sql`(EXISTS (SELECT 1 FROM information_schema.USER_PRIVILEGES u WHERE u.GRANTEE = ${GRANTEE} AND u.PRIVILEGE_TYPE = ${name})
    OR EXISTS (SELECT 1 FROM information_schema.SCHEMA_PRIVILEGES s WHERE s.GRANTEE = ${GRANTEE} AND s.TABLE_SCHEMA = t.TABLE_SCHEMA AND s.PRIVILEGE_TYPE = ${name})
    OR EXISTS (SELECT 1 FROM information_schema.TABLE_PRIVILEGES p WHERE p.GRANTEE = ${GRANTEE} AND p.TABLE_SCHEMA = t.TABLE_SCHEMA AND p.TABLE_NAME = t.TABLE_NAME AND p.PRIVILEGE_TYPE = ${name}))`;
}

const SOME_COLUMNS = sql`EXISTS (SELECT 1 FROM information_schema.COLUMN_PRIVILEGES c WHERE c.GRANTEE = ${GRANTEE} AND c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME AND c.PRIVILEGE_TYPE = 'SELECT')`;

function Relations(filter: Sql): Sql {
  return sql`SELECT t.TABLE_SCHEMA AS rel_schema, t.TABLE_NAME AS rel_name, t.TABLE_TYPE AS rel_type,
    t.CREATE_OPTIONS AS rel_options, t.TABLE_ROWS AS rel_rows, t.TABLE_COMMENT AS rel_comment,
    ${Privilege("SELECT")} AS can_select, ${SOME_COLUMNS} AS some_columns,
    ${Privilege("INSERT")} AS can_insert, ${Privilege("UPDATE")} AS can_update,
    ${Privilege("DELETE")} AS can_delete
    FROM information_schema.TABLES t
    WHERE t.TABLE_TYPE IN ('BASE TABLE', 'VIEW') AND t.TABLE_SCHEMA NOT IN ${SYSTEM_SCHEMAS} AND ${filter}
    ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME`;
}

function List(values: readonly string[]): Sql {
  return values.length === 0
    ? sql`(NULL)`
    : sql`(${join(values.map(param), sql`, `)})`;
}

/** A catalog cell as text: the server answers some `information_schema` columns as binary strings. */
function Text(row: Row, column: string): string {
  const cell = row.get(column);
  if (cell === null || cell === undefined) {
    return "";
  }
  return Buffer.isBuffer(cell) ? cell.toString("utf8") : String(cell);
}

function OptionalText(row: Row, column: string): string | null {
  const cell = row.get(column);
  return cell === null || cell === undefined ? null : Text(row, column);
}

function Flag(row: Row, column: string): boolean {
  return Number(row.get(column)) === 1;
}

function KindOf(row: Row): ExternalRelationKind {
  if (Text(row, "rel_type") !== BASE_TABLE) {
    return "view";
  }
  return Text(row, "rel_options").includes(PARTITIONED)
    ? "partitioned"
    : "table";
}

function CommentOf(row: Row, kind: ExternalRelationKind): string | null {
  const comment = Text(row, "rel_comment");
  return comment === "" || (kind === "view" && comment === VIEW_COMMENT)
    ? null
    : comment;
}

function ParseRelation(row: Row): RelationRow {
  const kind = KindOf(row);
  const rows = row.get("rel_rows");
  return {
    schema: Text(row, "rel_schema"),
    name: Text(row, "rel_name"),
    kind,
    readable: Flag(row, "can_select"),
    someColumns: Flag(row, "some_columns"),
    insert: Flag(row, "can_insert"),
    update: Flag(row, "can_update"),
    delete: Flag(row, "can_delete"),
    statistics:
      kind === "view" || rows === null || rows === undefined
        ? null
        : Number(rows),
    comment: CommentOf(row, kind),
  };
}

/** An enum's labels from its column type, `enum('a','it''s')`, in their declared order. */
function EnumLabels(native: string, dataType: string): string[] | null {
  if (dataType !== "enum") {
    return null;
  }
  return [...native.matchAll(ENUM_LABEL)].map((match) =>
    match[1].replaceAll("''", "'"),
  );
}

/**
 * A column as the catalog describes it. `native` is `COLUMN_TYPE` as the server spells it, its
 * keywords in lower case and an enum's labels in their own.
 */
function ParseColumn(row: Row): CatalogColumn {
  const native = Text(row, "native");
  const dataType = Text(row, "data_type").toLowerCase();
  const extra = Text(row, "extra");
  const fallback = OptionalText(row, "default_value");
  const expression = extra.includes(DEFAULT_GENERATED);
  const comment = Text(row, "comment");
  return {
    name: Text(row, "name"),
    native,
    dataType,
    notNull: Text(row, "nullable") !== NULLABLE,
    hasDefault: fallback !== null,
    defaultExpression: expression ? fallback : null,
    generated: GENERATED.test(extra),
    autoIncrement: AUTO_INCREMENT.test(extra),
    comment: comment === "" ? null : comment,
    enumLabels: EnumLabels(native, dataType),
    charset: OptionalText(row, "charset"),
    collation: OptionalText(row, "collation_name"),
  };
}

interface IndexParts {
  name: string;
  unique: boolean;
  total: boolean;
  notNull: boolean;
  columns: (string | null)[];
}

/** Folds one row per key part into one index each, keeping the parts in key order. */
function ParseIndexes(rows: readonly Row[]): CatalogIndex[] {
  const byName = new Map<string, IndexParts>();
  for (const row of rows) {
    const name = Text(row, "name");
    const column = OptionalText(row, "column_name");
    const whole =
      column !== null &&
      row.get("sub_part") === null &&
      Text(row, "visible") === VISIBLE;
    const index = byName.get(name) ?? {
      name,
      unique: Number(row.get("non_unique")) === 0,
      total: true,
      notNull: true,
      columns: [],
    };
    index.total &&= whole;
    index.notNull &&= Text(row, "nullable") !== NULLABLE;
    index.columns.push(column);
    byName.set(name, index);
  }
  return [...byName.values()].map((index) => ({
    name: index.name,
    primary: index.name === PRIMARY,
    unique: index.unique,
    total: index.total,
    notNull: index.notNull,
    columns: index.columns.every((column) => column !== null)
      ? index.columns.filter((column) => column !== null)
      : [],
  }));
}

interface ReferenceParts {
  name: string;
  fromRelation: string;
  fromColumns: string[];
  toRelation: string;
  toColumns: string[];
}

function ParseReferences(rows: readonly Row[]): ReferenceRow[] {
  const byName = new Map<string, ReferenceParts>();
  for (const row of rows) {
    const fromRelation = `${Text(row, "from_schema")}.${Text(row, "from_table")}`;
    const name = Text(row, "name");
    const id = `${fromRelation}.${name}`;
    const reference = byName.get(id) ?? {
      name,
      fromRelation,
      fromColumns: [],
      toRelation: `${Text(row, "to_schema")}.${Text(row, "to_table")}`,
      toColumns: [],
    };
    reference.fromColumns.push(Text(row, "from_column"));
    reference.toColumns.push(Text(row, "to_column"));
    byName.set(id, reference);
  }
  return [...byName.values()];
}

/** `user@host` is the account; its user is what came before the last `@`. */
function UserOf(account: string): string {
  const at = account.lastIndexOf(USER_SEPARATOR);
  return at < 0 ? account : account.slice(0, at);
}

const PERCENT = 100;

/** Rows each step of a traditional plan reads times the share it keeps, multiplied over a join. */
function ParsePlannedRows(rows: readonly Row[]): number | null {
  if (rows.length === 0) {
    return null;
  }
  return rows.reduce((product, row) => {
    const read = Number(row.get("rows") ?? 0);
    const kept = Number(row.get("filtered") ?? PERCENT) / PERCENT;
    return product * read * kept;
  }, 1);
}

export function ExternalCatalogOf(flavour: Flavour): ExternalCatalogSyntax {
  return {
    relations: (schemas) =>
      Relations(schemas ? sql`t.TABLE_SCHEMA IN ${List(schemas)}` : sql`TRUE`),
    namedRelations: (names) =>
      Relations(
        sql`CONCAT(t.TABLE_SCHEMA, '.', t.TABLE_NAME) IN ${List(names)}`,
      ),
    parseRelation: ParseRelation,
    columns: (schema, table) =>
      sql`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS native, DATA_TYPE AS data_type, IS_NULLABLE AS nullable,
      ${flavour.columnDefault.value} AS default_value, ${flavour.columnDefault.extra} AS extra, COLUMN_COMMENT AS comment,
      CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation_name
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${param(schema)} AND TABLE_NAME = ${param(table)}
      ORDER BY ORDINAL_POSITION`,
    parseColumn: ParseColumn,
    jsonColumns: flavour.jsonColumns,
    indexes: (schema, table) =>
      sql`SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, COLUMN_NAME AS column_name, SUB_PART AS sub_part,
      ${flavour.indexVisible} AS visible, NULLABLE AS nullable
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ${param(schema)} AND TABLE_NAME = ${param(table)}
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    parseIndexes: ParseIndexes,
    references: (schema, table) =>
      sql`SELECT CONSTRAINT_NAME AS name, TABLE_SCHEMA AS from_schema, TABLE_NAME AS from_table, COLUMN_NAME AS from_column,
      REFERENCED_TABLE_SCHEMA AS to_schema, REFERENCED_TABLE_NAME AS to_table, REFERENCED_COLUMN_NAME AS to_column
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE REFERENCED_TABLE_NAME IS NOT NULL AND ((TABLE_SCHEMA = ${param(schema)} AND TABLE_NAME = ${param(table)})
        OR (REFERENCED_TABLE_SCHEMA = ${param(schema)} AND REFERENCED_TABLE_NAME = ${param(table)}))
      ORDER BY CONSTRAINT_NAME, TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
    parseReferences: ParseReferences,
    info: () =>
      sql`SELECT VERSION() AS version, DATABASE() AS current_database, CURRENT_USER() AS account`,
    parseInfo: (row) => ({
      version: Text(row, "version"),
      database: Text(row, "current_database"),
      role: UserOf(Text(row, "account")),
    }),
    plannedRows: (schema, table) =>
      sql`EXPLAIN FORMAT=TRADITIONAL SELECT * FROM ${ident(schema)}.${ident(table)}`,
    parsePlannedRows: ParsePlannedRows,
  };
}
