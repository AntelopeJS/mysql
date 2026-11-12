import type { CaptureOutput, CaseCapture } from "./results";
import type { Backend } from "./settings";

export type EngineId =
  | "postgres-18"
  | "mysql-8.4"
  | "mysql-9.7"
  | "mariadb-11.8"
  | "mariadb-12.3";

/** A statement the server ran for one query, with the plan it explained it with. */
export interface StatementPlan {
  readonly text: string;
  /** The plan as the engine prints it, conditions cut to a readable width. */
  readonly plan: string;
  /** The declared indexes the plan reads, by the name the query declares them under. */
  readonly indexes: readonly string[];
}

/** What the server logged for one query over the capture runs. */
export interface CasePlan {
  readonly id: string;
  readonly statements: readonly StatementPlan[];
  /** The server's time per run of the query, in ms: each statement of the run, summed. */
  readonly serverMs: readonly number[];
  /** The rows the server examined per run, where the engine counts them. */
  readonly rowsExamined: readonly number[];
  /** The statements logged in the query's window: a multiple of its runs, or the split above is empty. */
  readonly logged: number;
}

/** One server under test, from its container to the plans of the statements the module sent it. */
export interface Engine {
  readonly id: EngineId;
  readonly backend: Backend;
  readonly image: string;
  start(): Promise<void>;
  /** The URL the backend module connects with. */
  url(): string;
  version(): Promise<string>;
  /** Refreshes the statistics of every table the module made, as a production server keeps them. */
  analyze(): Promise<void>;
  /** The DDL of the indexed books table, as the server reports it. */
  indexedTableDdl(): Promise<string>;
  /** Runs `run` with the server logging each statement, and answers each query's statements and plans. */
  capture(run: () => Promise<CaptureOutput>): Promise<CasePlan[]>;
  stop(): Promise<void>;
}

/** A logged statement, at the time the server logged it. */
export interface LoggedStatement {
  readonly at: number;
  readonly text: string;
  readonly serverMs: number;
  readonly rowsExamined?: number;
}

const WINDOW_SLACK_MS = 20;

/** The statements logged inside one query's runs, the gaps between queries keeping them apart. */
export function InWindow<Statement extends LoggedStatement>(
  logged: readonly Statement[],
  window: CaseCapture,
): Statement[] {
  return logged.filter(
    (statement) =>
      statement.at >= window.startedAt - WINDOW_SLACK_MS &&
      statement.at <= window.endedAt + WINDOW_SLACK_MS,
  );
}

/** The statement texts of one run: those logged in a window, each text once, in their order. */
export function DistinctTexts(
  statements: readonly LoggedStatement[],
): string[] {
  return [...new Set(statements.map((statement) => statement.text))];
}

/** Splits a window's statements into its runs, `perRun` statements each, and sums each run. */
export function PerRun(
  statements: readonly LoggedStatement[],
  runs: number,
  value: (statement: LoggedStatement) => number,
): number[] {
  if (runs === 0 || statements.length % runs !== 0) {
    return [];
  }
  const perRun = statements.length / runs;
  return Array.from({ length: runs }, (_, run) =>
    statements
      .slice(run * perRun, (run + 1) * perRun)
      .reduce((total, statement) => total + value(statement), 0),
  );
}

const CONDITION_WIDTH = 160;

/** A plan line with any long condition cut, so a plan stays readable in a report. */
export function Shortened(line: string): string {
  return line.length > CONDITION_WIDTH
    ? `${line.slice(0, CONDITION_WIDTH)}…`
    : line;
}
