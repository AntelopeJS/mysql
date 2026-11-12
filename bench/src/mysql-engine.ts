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

interface AnalyzeRow extends RowDataPacket {
  EXPLAIN: string;
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

/** A MySQL server in a container, measured through its slow log and explained with `EXPLAIN`. */
export class MySqlEngine implements Engine {
  public readonly backend = "mysql" as const;
  private port = 0;

  public constructor(
    public readonly id: EngineId,
    public readonly image: string,
    private readonly container: string,
  ) {}

  public async start(): Promise<void> {
    StartContainer(
      this.container,
      this.image,
      PORT,
      { MYSQL_ROOT_PASSWORD: PASSWORD },
      [`--innodb-buffer-pool-size=${BUFFER_POOL}`],
    );
    this.port = PublishedPort(this.container, PORT);
    await WaitReady(this.container, () =>
      Exec("docker", [
        "exec",
        this.container,
        "mysql",
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
      return `MySQL ${row?.version ?? "unknown"}`;
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
    const traditional = await this.rows<ExplainRow>(
      connection,
      `EXPLAIN FORMAT=TRADITIONAL ${text}`,
    );
    const analyzed = await this.rows<AnalyzeRow>(
      connection,
      `EXPLAIN ANALYZE ${text}`,
    );
    const header = EXPLAIN_COLUMNS.join(" | ");
    const lines = traditional.map((row) =>
      Shortened(EXPLAIN_COLUMNS.map((column) => Text(row[column])).join(" | ")),
    );
    const tree = analyzed
      .flatMap((row) => row.EXPLAIN.split("\n"))
      .map(Shortened);
    const indexes = traditional
      .map((row) => Text(row.key))
      .filter((key) => DECLARED.has(key));
    return {
      text,
      plan: [
        "EXPLAIN FORMAT=TRADITIONAL",
        header,
        ...lines,
        "",
        "EXPLAIN ANALYZE",
        ...tree,
      ].join("\n"),
      indexes: [...new Set(indexes)],
    };
  }

  public async stop(): Promise<void> {
    RemoveContainer(this.container);
  }
}
