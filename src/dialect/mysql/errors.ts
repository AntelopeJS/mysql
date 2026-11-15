import type { ErrorSyntax, Failure } from "../error-types";
import { IsNumber, IsString } from "../../implementations/database/guards";

const DUPLICATE_ENTRY = 1062;
const DATA_TOO_LONG = 1406;
const LOCK_WAIT_TIMEOUT = 1205;
const DEADLOCK = 1213;
/** `ER_BINLOG_STMT_MODE_AND_ROW_ENGINE`, on MySQL and MariaDB alike. */
const STATEMENT_BINLOG = 1665;
const OUT_OF_MEMORY = 1037;
const OUT_OF_SORT_MEMORY = 1038;
const OUT_OF_RESOURCES = 1041;
const USER_LIMIT_REACHED = 1226;
const QUERY_INTERRUPTED = 1317;
const MAX_PREPARED_STATEMENTS = 1461;

/** The errors by which the server says it could not take a statement up, whatever the account may do. */
const UNANSWERED: ReadonlySet<number> = new Set([
  OUT_OF_MEMORY,
  OUT_OF_SORT_MEMORY,
  OUT_OF_RESOURCES,
  USER_LIMIT_REACHED,
  QUERY_INTERRUPTED,
  MAX_PREPARED_STATEMENTS,
  LOCK_WAIT_TIMEOUT,
  DEADLOCK,
]);

const BARE: ReadonlyMap<number, Failure> = new Map([
  [LOCK_WAIT_TIMEOUT, { kind: "lockWait" }],
  [DEADLOCK, { kind: "deadlock" }],
  [STATEMENT_BINLOG, { kind: "binlogFormat" }],
]);

/** `Duplicate entry '<value>' for key '<table>.<index>'`; the value may itself hold quotes. */
const DUPLICATE_KEY = /for key '(.*)'$/s;

/** `Data too long for column '<column>' at row <n>`. */
const TOO_LONG_COLUMN = /for column '(.*)' at row \d+$/s;

interface ServerError {
  readonly errno: number;
  readonly message: string;
}

/**
 * The error the server answered, if it answered one: a positive errno beside a SQL state, on an
 * error that did not also end the connection. A Node socket error carries a negative errno and no
 * SQL state.
 */
function ServerErrorOf(error: Error): ServerError | undefined {
  if ("fatal" in error && error.fatal === true) {
    return undefined;
  }
  if (!("errno" in error) || !("sqlState" in error)) {
    return undefined;
  }
  const errno = error.errno;
  if (!IsNumber(errno) || errno <= 0 || !IsString(error.sqlState)) {
    return undefined;
  }
  return { errno, message: error.message };
}

function Classify(error: Error): Failure {
  const server = ServerErrorOf(error);
  if (!server) {
    return { kind: "connection" };
  }
  if (server.errno === DUPLICATE_ENTRY) {
    const key = DUPLICATE_KEY.exec(server.message)?.[1];
    return key === undefined ? { kind: "server" } : { kind: "duplicate", key };
  }
  if (server.errno === DATA_TOO_LONG) {
    const column = TOO_LONG_COLUMN.exec(server.message)?.[1];
    return column === undefined
      ? { kind: "server" }
      : { kind: "tooLong", column };
  }
  return BARE.get(server.errno) ?? { kind: "server" };
}

function Unanswered(error: Error): boolean {
  const server = ServerErrorOf(error);
  return server !== undefined && UNANSWERED.has(server.errno);
}

export const errors: ErrorSyntax = {
  classify: Classify,
  unanswered: Unanswered,
};
