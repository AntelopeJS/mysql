import {
  createConnection,
  type Connection,
  type RowDataPacket,
} from "mysql2/promise";

import { INDEXES } from "./dataset";
import {
  Exec,
  PublishedPort,
  RemoveContainer,
  StartContainer,
  WaitReady,
} from "./docker";
import {
  DistinctTexts,
  InWindow,
  PerRun,
  Shortened,
  type CasePlan,
  type Engine,
  type EngineId,
  type LoggedStatement,
  type StatementPlan,
} from "./engine";
import type { CaptureOutput } from "./results";

const PORT = 3306;
const PASSWORD = "antelopejs-bench";
const DATABASE = "bench";
const BUFFER_POOL = "1G";
const DECLARED = new Set<string>(Object.values(INDEXES));
const EXPLAIN_COLUMNS = [
  "id",
  "select_type",
  "table",
  "type",
  "possible_keys",
  "key",
  "key_len",
  "rows",
  "filtered",
  "Extra",
] as const;
const STATEMENT = /^\s*(SELECT|WITH|\()/i;

/** A cell as the driver hands it over with `dateStrings`: text, a number, bytes or NULL. */
type CellValue = string | number | Buffer | null;

function Text(value: CellValue): string {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return value === null ? "NULL" : String(value);
}

interface SlowLogRow extends RowDataPacket {
  start_time: string;
  query_time: string;
  rows_examined: number;
  sql_text: Buffer;
}

type ExplainColumn = (typeof EXPLAIN_COLUMNS)[number];

type ExplainRow = RowDataPacket & Record<ExplainColumn, CellValue>;

/** How a server of the MySQL family differs from the others, as the statements and names it takes. */
export interface Flavor {
  readonly name: string;
  /** The command-line client inside the image. */
  readonly client: string;
  readonly rootPasswordVariable: string;
  /** The statement prefix that explains a statement with a `filtered` column. */
  readonly explain: string;
  /** The statement prefix that runs a statement and reports the rows it really read. */
  readonly analyze: string;
}

export const MYSQL: Flavor = {
  name: "MySQL",
  client: "mysql",
  rootPasswordVariable: "MYSQL_ROOT_PASSWORD",
  explain: "EXPLAIN FORMAT=TRADITIONAL",
  analyze: "EXPLAIN ANALYZE",
};

export const MARIADB: Flavor = {
  name: "MariaDB",
  client: "mariadb",
  rootPasswordVariable: "MARIADB_ROOT_PASSWORD",
  explain: "EXPLAIN EXTENDED",
  analyze: "ANALYZE",
};

function IsCell(value: unknown): value is CellValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    Buffer.isBuffer(value)
  );
}

/** One column of a row the driver typed loosely, as text; a cell of another kind is a driver change worth failing on. */
function CellText(row: RowDataPacket, column: string): string {
  const value: unknown = row[column];
  if (!IsCell(value)) {
    throw new Error(`column ${column} holds a cell of no known kind`);
  }
  return Text(value);
}

/** The lines of an analysis: MySQL answers a text tree in one column, MariaDB a table with `r_rows`. */
function AnalysisLines(rows: readonly RowDataPacket[]): string[] {
  const first = rows[0];
  if (first !== undefined && Object.hasOwn(first, "EXPLAIN")) {
    return rows.flatMap((row) => CellText(row, "EXPLAIN").split("\n"));
  }
  const columns = first === undefined ? [] : Object.keys(first);
  return [
    columns.join(" | "),
    ...rows.map((row) =>
      columns.map((column) => CellText(row, column)).join(" | "),
    ),
  ];
}

interface NamedRow extends RowDataPacket {
  name: string;
}

interface VersionRow extends RowDataPacket {
  version: string;
}

interface CreateTableRow extends RowDataPacket {
  "Create Table": string;
}

/** `HH:MM:SS.ffffff` as the slow log writes a statement's time, in ms. */
function Milliseconds(time: string): number {
  const [hours = 0, minutes = 0, seconds = 0] = time.split(":").map(Number);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

/**
 * A row of the slow log at its `start_time`, read as UTC: the session reading it is pinned to UTC.
 * That time falls inside the query's window whether the server stamps the start or the end.
 */
function Logged(row: SlowLogRow): LoggedStatement {
  const serverMs = Milliseconds(row.query_time);
  return {
    at: Date.parse(`${row.start_time.replace(" ", "T")}Z`),
    text: Text(row.sql_text),
    serverMs,
    rowsExamined: Number(row.rows_examined),
  };
}

/** A server of the MySQL family in a container, measured through its slow log and explained by its own statements. */
export class MySqlEngine implements Engine {
  public readonly backend = "mysql" as const;
  private port = 0;

  public constructor(
    public readonly id: EngineId,
    public readonly image: string,
    private readonly container: string,
    private readonly flavor: Flavor = MYSQL,
  ) {}

  public async start(): Promise<void> {
    StartContainer(
      this.container,
      this.image,
      PORT,
      { [this.flavor.rootPasswordVariable]: PASSWORD },
      [`--innodb-buffer-pool-size=${BUFFER_POOL}`],
    );
    this.port = PublishedPort(this.container, PORT);
    await WaitReady(this.container, () =>
      Exec("docker", [
        "exec",
        this.container,
        this.flavor.client,
        "-uroot",
        `-p${PASSWORD}`,
        "-h127.0.0.1",
        "-e",
        `CREATE DATABASE IF NOT EXISTS ${DATABASE}`,
      ]),
    );
  }

  public url(): string {
    return `mysql://root:${PASSWORD}@127.0.0.1:${this.port}/${DATABASE}`;
  }

  private async admin<T>(
    work: (connection: Connection) => Promise<T>,
  ): Promise<T> {
    const connection = await createConnection({
      uri: this.url(),
      dateStrings: true,
    });
    try {
      await connection.query("SET time_zone = '+00:00'");
      return await work(connection);
    } finally {
      await connection.end();
    }
  }

  private async rows<Row extends RowDataPacket>(
    connection: Connection,
    statement: string,
  ): Promise<Row[]> {
    const [rows] = await connection.query<Row[]>(statement);
    return rows;
  }

  public async version(): Promise<string> {
    return this.admin(async (connection) => {
      const [row] = await this.rows<VersionRow>(
        connection,
        "SELECT VERSION() AS version",
      );
      const [release = "unknown"] = (row?.version ?? "unknown").split("-");
      return `${this.flavor.name} ${release}`;
    });
  }

  private async tables(connection: Connection): Promise<string[]> {
    const rows = await this.rows<NamedRow>(
      connection,
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${DATABASE}' AND TABLE_NAME LIKE 'nested-bench%' ORDER BY TABLE_NAME`,
    );
    return rows.map((row) => row.name);
  }

  public async analyze(): Promise<void> {
    await this.admin(async (connection) => {
      for (const table of await this.tables(connection)) {
        await connection.query(`ANALYZE TABLE \`${table}\``);
      }
    });
  }

  public async indexedTableDdl(): Promise<string> {
    return this.admin(async (connection) => {
      const table = (await this.tables(connection)).find((name) =>
        name.endsWith("books_indexed"),
      );
      const [row] = await this.rows<CreateTableRow>(
        connection,
        `SHOW CREATE TABLE \`${table}\``,
      );
      return row?.["Create Table"] ?? "";
    });
  }

  public async capture(run: () => Promise<CaptureOutput>): Promise<CasePlan[]> {
    const { logged, pin, output } = await this.logged(run);
    return this.admin(async (connection) => {
      await connection.query(pin);
      const plans: CasePlan[] = [];
      for (const window of output.cases) {
        const statements = InWindow(logged, window);
        const statementPlans: StatementPlan[] = [];
        for (const text of DistinctTexts(statements)) {
          statementPlans.push(await this.explain(connection, text));
        }
        plans.push({
          id: window.id,
          statements: statementPlans,
          serverMs: PerRun(
            statements,
            window.runs,
            (statement) => statement.serverMs,
          ),
          rowsExamined: PerRun(
            statements,
            window.runs,
            (statement) => statement.rowsExamined ?? 0,
          ),
          logged: statements.length,
        });
      }
      return plans;
    });
  }

  /** Runs `run` with every statement in the slow log, and answers what it logged and the session pin. */
  private async logged(run: () => Promise<CaptureOutput>) {
    await this.admin(async (connection) => {
      await connection.query("SET GLOBAL slow_query_log = OFF");
      await connection.query("TRUNCATE TABLE mysql.slow_log");
      await connection.query(
        "SET GLOBAL log_output = 'TABLE', long_query_time = 0",
      );
      await connection.query("SET GLOBAL slow_query_log = ON");
    });
    let output: CaptureOutput;
    try {
      output = await run();
    } finally {
      await this.admin(async (connection) => {
        await connection.query(
          "SET GLOBAL slow_query_log = OFF, long_query_time = DEFAULT",
        );
      });
    }
    return this.admin(async (connection) => {
      const rows = await this.rows<SlowLogRow>(
        connection,
        "SELECT start_time, query_time, rows_examined, sql_text FROM mysql.slow_log ORDER BY start_time",
      );
      const all = rows.map(Logged);
      const pin = all.find((statement) =>
        statement.text.startsWith("SET NAMES"),
      );
      if (!pin) {
        throw new Error(`${this.id} logged no session pin`);
      }
      const logged = all
        .filter((statement) => STATEMENT.test(statement.text))
        .sort((left, right) => left.at - right.at);
      return { logged, pin: pin.text, output };
    });
  }

  private async explain(
    connection: Connection,
    text: string,
  ): Promise<StatementPlan> {
    const { explain, analyze } = this.flavor;
    const traditional = await this.rows<ExplainRow>(
      connection,
      `${explain} ${text}`,
    );
    const analyzed = await this.rows<RowDataPacket>(
      connection,
      `${analyze} ${text}`,
    );
    const header = EXPLAIN_COLUMNS.join(" | ");
    const lines = traditional.map((row) =>
      Shortened(EXPLAIN_COLUMNS.map((column) => Text(row[column])).join(" | ")),
    );
    const tree = AnalysisLines(analyzed).map(Shortened);
    const indexes = traditional
      .map((row) => Text(row.key))
      .filter((key) => DECLARED.has(key));
    return {
      text,
      plan: [explain, header, ...lines, "", analyze, ...tree].join("\n"),
      indexes: [...new Set(indexes)],
    };
  }

  public async stop(): Promise<void> {
    RemoveContainer(this.container);
  }
}
