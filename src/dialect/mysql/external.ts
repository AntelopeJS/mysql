import type {
  ExternalFailure,
  ExternalFailureKind,
  ExternalMeasureSyntax,
  ExternalSyntax,
} from "../external";
import { int, param, sql } from "../../statement";
import { IsNumber } from "../../implementations/database/guards";
import { catalog } from "./external-catalog";
import { types } from "./external-types";

/** `max_execution_time` stopped a read, and a lock wait ran out. */
const TIMEOUT_ERRNOS: readonly number[] = [3024, 1205];
const SAMPLE_SEED = 42;

/** What the write errnos external mode names mean, and where their message names a column or constraint. */
interface Mapping {
  readonly kind: ExternalFailureKind;
  readonly column?: RegExp;
  readonly constraint?: RegExp;
}

const NAMED_COLUMN = /column '((?:[^']|'')*)'/i;
const NAMED_FIELD = /^Field '((?:[^']|'')*)'/;
const NAMED_KEY = /for key '(.*)'$/s;
const NAMED_FOREIGN_KEY = /CONSTRAINT `((?:[^`]|``)*)` FOREIGN KEY/;
const NAMED_CHECK = /^Check constraint '((?:[^']|'')*)' is violated/;

const MAPPINGS = new Map<number, Mapping>([
  [1048, { kind: "missing", column: NAMED_COLUMN }],
  [1364, { kind: "missing", column: NAMED_FIELD }],
  [1062, { kind: "duplicate", constraint: NAMED_KEY }],
  [1452, { kind: "reference", constraint: NAMED_FOREIGN_KEY }],
  [1451, { kind: "referenced", constraint: NAMED_FOREIGN_KEY }],
  [3819, { kind: "check", constraint: NAMED_CHECK }],
  [1142, { kind: "forbidden" }],
  [1143, { kind: "forbidden" }],
  [1264, { kind: "invalid", column: NAMED_COLUMN }],
  [1265, { kind: "invalid", column: NAMED_COLUMN }],
  [1292, { kind: "invalid", column: NAMED_COLUMN }],
  [1366, { kind: "invalid", column: NAMED_COLUMN }],
  [1406, { kind: "invalid", column: NAMED_COLUMN }],
]);

/** The errno the server answered with; a Node socket error carries a negative one. */
function ErrnoOf(error: Error): number | undefined {
  if (!("errno" in error) || !IsNumber(error.errno) || error.errno <= 0) {
    return undefined;
  }
  return error.errno;
}

function Named(pattern: RegExp | undefined, message: string) {
  const name = pattern?.exec(message)?.[1];
  return name?.replaceAll("''", "'").replaceAll("``", "`");
}

/** The errno a failed write carries, as what it means; messages are English under the session pin. */
function Failure(error: Error): ExternalFailure | undefined {
  const errno = ErrnoOf(error);
  const mapping = errno === undefined ? undefined : MAPPINGS.get(errno);
  if (errno === undefined || !mapping) {
    return undefined;
  }
  return {
    kind: mapping.kind,
    code: String(errno),
    column: Named(mapping.column, error.message),
    constraint: Named(mapping.constraint, error.message),
  };
}

const measures: ExternalMeasureSyntax = {
  open: (timeoutMs) => [
    sql`SET SESSION max_execution_time = ${int(timeoutMs)}`,
    sql`SET SESSION lock_wait_timeout = 1`,
    sql`SET SESSION innodb_lock_wait_timeout = 1`,
    sql`START TRANSACTION READ ONLY`,
  ],
  close: sql`ROLLBACK`,
  failure: (error) => {
    const errno = ErrnoOf(error);
    return {
      code: errno === undefined ? "unknown" : String(errno),
      timeout: errno !== undefined && TIMEOUT_ERRNOS.includes(errno),
    };
  },
  sampled: (key, every) => sql`(CRC32(${key}) % ${int(every)} = 0)`,
  sampledRandomly: (share) =>
    sql`(RAND(${int(SAMPLE_SEED)}) < ${param(share)})`,
  length: (text) => sql`CHAR_LENGTH(${text})`,
  bytes: (value) => sql`OCTET_LENGTH(${value})`,
  month: (instant) => sql`DATE_FORMAT(${instant}, '%Y-%m')`,
};

export const external: ExternalSyntax = {
  engine: "mysql",
  catalog,
  types,
  measures,
  failure: Failure,
};
