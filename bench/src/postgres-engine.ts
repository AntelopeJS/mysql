import { spawnSync } from "node:child_process";

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

const PORT = 5432;
const PASSWORD = "antelopejs-bench";
const DATABASE = "bench";
const SHARED_BUFFERS = "1GB";
const DECLARED: readonly string[] = Object.values(INDEXES);
const STATEMENT = /^\s*(SELECT|WITH|\()/i;
const PLAN_HEADER =
  /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}) UTC \[\d+\] LOG: {2}duration: ([\d.]+) ms {2}plan:$/;
const SCANS = new Set([
  "Seq Scan",
  "Index Scan",
  "Index Only Scan",
  "Bitmap Heap Scan",
]);
const INDENT = "  ";

/** A value as `JSON.parse` yields it. */
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

interface JsonObject {
  [key: string]: JsonValue;
}

function IsJson(value: unknown): value is JsonValue {
  if (
    value === null ||
    ["boolean", "number", "string"].includes(typeof value)
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(IsJson);
  }
  return typeof value === "object" && Object.values(value).every(IsJson);
}

function IsObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function IsText(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

function IsCount(value: JsonValue | undefined): value is number {
  return typeof value === "number";
}

/** A plan node as `auto_explain` writes it in JSON, read through its own keys only. */
type PlanNode = JsonObject;

function Get(node: PlanNode, key: string): JsonValue | undefined {
  return Object.hasOwn(node, key) ? node[key] : undefined;
}

function TextOf(node: PlanNode, key: string): string | undefined {
  const value = Get(node, key);
  return IsText(value) ? value : undefined;
}

function NumberOf(node: PlanNode, key: string): number {
  const value = Get(node, key);
  return IsCount(value) ? value : 0;
}

function Children(node: PlanNode): PlanNode[] {
  const plans = Get(node, "Plans");
  return Array.isArray(plans) ? plans.filter(IsObject) : [];
}

/** A plan detail as `EXPLAIN` prints it in text: a list joined, anything else as written. */
function Detail(value: JsonValue): string {
  if (Array.isArray(value)) {
    return value.map(Detail).join(", ");
  }
  return IsText(value) ? value : JSON.stringify(value);
}

function Nodes(node: PlanNode): PlanNode[] {
  return [node, ...Children(node).flatMap(Nodes)];
}

const DETAILS = [
  "Index Cond",
  "Recheck Cond",
  "Filter",
  "Rows Removed by Filter",
  "Join Filter",
  "Hash Cond",
  "Sort Key",
  "Sort Method",
] as const;

/** One node and its children as `EXPLAIN` prints them in text, with the counts `ANALYZE` adds. */
function Rendered(node: PlanNode, depth: number): string[] {
  const indent = INDENT.repeat(depth);
  const index = TextOf(node, "Index Name");
  const relation = TextOf(node, "Relation Name");
  const title = [
    TextOf(node, "Node Type") ?? "?",
    index ? `using ${index}` : "",
    relation ? `on ${relation}` : "",
    `(actual rows=${NumberOf(node, "Actual Rows")} loops=${NumberOf(node, "Actual Loops")})`,
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  const details = DETAILS.flatMap((key) => {
    const value = Get(node, key);
    return value === undefined
      ? []
      : [Shortened(`${indent}${INDENT}${key}: ${Detail(value)}`)];
  });
  return [
    `${indent}${depth > 0 ? "-> " : ""}${title}`,
    ...details,
    ...Children(node).flatMap((child) => Rendered(child, depth + 1)),
  ];
}

/** The rows the scans of a plan read, those its filters removed included. */
function RowsRead(plan: PlanNode): number {
  return Nodes(plan)
    .filter((node) => SCANS.has(TextOf(node, "Node Type") ?? ""))
    .reduce(
      (total, node) =>
        total +
        (NumberOf(node, "Actual Rows") +
          NumberOf(node, "Rows Removed by Filter")) *
          NumberOf(node, "Actual Loops"),
      0,
    );
}

/** The declared index a physical index backs: the module names it `<table>_<index>`. */
function DeclaredIndexes(plan: PlanNode): string[] {
  const names = Nodes(plan).flatMap((node) => {
    const name = TextOf(node, "Index Name");
    return name
      ? DECLARED.filter((declared) => name.endsWith(`_${declared}`))
      : [];
  });
  return [...new Set(names)];
}

interface ExplainedStatement extends LoggedStatement {
  readonly plan: PlanNode;
  readonly parameters: string;
}

/** The plans `auto_explain` logged since `since`, at the time each was logged. */
function LoggedPlans(log: string): ExplainedStatement[] {
  const statements: ExplainedStatement[] = [];
  const lines = log.split("\n");
  for (let at = 0; at < lines.length; at++) {
    const header = PLAN_HEADER.exec(lines[at] ?? "");
    if (!header) {
      continue;
    }
    const body: string[] = [];
    while (at + 1 < lines.length && (lines[at + 1] ?? "").startsWith("\t")) {
      body.push(lines[++at] ?? "");
    }
    const parsed: unknown = JSON.parse(body.join("\n"));
    if (!IsJson(parsed) || !IsObject(parsed)) {
      continue;
    }
    const plan = Get(parsed, "Plan");
    if (!IsObject(plan)) {
      continue;
    }
    statements.push({
      at: Date.parse(`${(header[1] ?? "").replace(" ", "T")}Z`),
      text: TextOf(parsed, "Query Text") ?? "",
      parameters: TextOf(parsed, "Query Parameters") ?? "",
      serverMs: Number(header[2]),
      rowsExamined: RowsRead(plan),
      plan,
    });
  }
  return statements;
}

/** A PostgreSQL server in a container, measured and explained through `auto_explain`. */
export class PostgresEngine implements Engine {
  public readonly backend = "postgres" as const;
  private port = 0;

  public constructor(
    public readonly id: EngineId,
    public readonly image: string,
    private readonly container: string,
  ) {}

  private psql(statement: string, database = DATABASE): string {
    return Exec("docker", [
      "exec",
      this.container,
      "psql",
      "-U",
      "postgres",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      statement,
    ]).trim();
  }

  public async start(): Promise<void> {
    StartContainer(
      this.container,
      this.image,
      PORT,
      { POSTGRES_PASSWORD: PASSWORD },
      [
        "-c",
        "shared_preload_libraries=auto_explain",
        "-c",
        `shared_buffers=${SHARED_BUFFERS}`,
        "-c",
        "auto_explain.log_format=json",
        "-c",
        "auto_explain.log_analyze=on",
        "-c",
        "auto_explain.log_timing=off",
        "-c",
        "auto_explain.log_buffers=on",
      ],
    );
    this.port = PublishedPort(this.container, PORT);
    await WaitReady(this.container, () => {
      this.psql("SELECT 1", "postgres");
    });
    this.psql(`CREATE DATABASE ${DATABASE}`, "postgres");
  }

  public url(): string {
    return `postgres://postgres:${PASSWORD}@127.0.0.1:${this.port}/${DATABASE}`;
  }

  public async version(): Promise<string> {
    return `PostgreSQL ${this.psql("SHOW server_version")}`;
  }

  public async analyze(): Promise<void> {
    this.psql("ANALYZE");
  }

  public async indexedTableDdl(): Promise<string> {
    return this.psql(
      "SELECT string_agg(indexdef, E';\\n' ORDER BY indexname) FROM pg_indexes WHERE tablename = 'books_indexed'",
    );
  }

  private setMinDuration(value: string): void {
    this.psql(`ALTER SYSTEM SET auto_explain.log_min_duration = ${value}`);
    this.psql("SELECT pg_reload_conf()");
  }

  public async capture(run: () => Promise<CaptureOutput>): Promise<CasePlan[]> {
    const since = new Date().toISOString();
    this.setMinDuration("0");
    let output: CaptureOutput;
    try {
      output = await run();
    } finally {
      this.setMinDuration("-1");
    }
    const logs = spawnSync(
      "docker",
      ["logs", "--since", since, this.container],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 1024,
      },
    );
    const logged = LoggedPlans(`${logs.stdout}\n${logs.stderr}`)
      .filter((statement) => STATEMENT.test(statement.text))
      .sort((left, right) => left.at - right.at);
    return output.cases.map((window) => {
      const statements = InWindow(logged, window);
      const texts = DistinctTexts(statements);
      return {
        id: window.id,
        statements: texts.map((text): StatementPlan => {
          const last = statements
            .filter((statement) => statement.text === text)
            .at(-1);
          const plan = last?.plan ?? {};
          return {
            text: last?.parameters ? `${text}\n-- ${last.parameters}` : text,
            plan: [
              "EXPLAIN (ANALYZE, TIMING OFF) through auto_explain",
              ...Rendered(plan, 0),
            ].join("\n"),
            indexes: DeclaredIndexes(plan),
          };
        }),
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
      };
    });
  }

  public async stop(): Promise<void> {
    RemoveContainer(this.container);
  }
}
