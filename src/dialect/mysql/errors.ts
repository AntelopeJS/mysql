import type { ErrorSyntax, Failure } from "../error-types";
import { IsNumber, IsString } from "../../implementations/database/guards";

const DUPLICATE_ENTRY = 1062;
const DATA_TOO_LONG = 1406;
const LOCK_WAIT_TIMEOUT = 1205;
const DEADLOCK = 1213;

const WAITS: ReadonlyMap<number, Failure> = new Map([
  [LOCK_WAIT_TIMEOUT, { kind: "lockWait" }],
  [DEADLOCK, { kind: "deadlock" }],
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
  return WAITS.get(server.errno) ?? { kind: "server" };
}

export const errors: ErrorSyntax = { classify: Classify };
