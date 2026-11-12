import type {
  ExternalFailure,
  ExternalFailureKind,
  ExternalMeasureSyntax,
  ExternalSyntax,
} from "../external";
import { int, param, sql } from "../../statement";
import { IsNumber } from "../../implementations/database/guards";
import { ExternalCatalogOf } from "./external-catalog";
import type { Flavour } from "./flavour";
import { TypesOf } from "./external-types";

/** A lock wait ran out, which a read stopped by its timeout also means. */
const LOCK_WAIT_TIMEOUT = 1205;
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

const MAPPINGS = new Map<number, Mapping>([
  [1048, { kind: "missing", column: NAMED_COLUMN }],
  [1364, { kind: "missing", column: NAMED_FIELD }],
  [1062, { kind: "duplicate", constraint: NAMED_KEY }],
  [1452, { kind: "reference", constraint: NAMED_FOREIGN_KEY }],
  [1451, { kind: "referenced", constraint: NAMED_FOREIGN_KEY }],
  [1142, { kind: "forbidden" }],
  [1143, { kind: "forbidden" }],
  [1264, { kind: "invalid", column: NAMED_COLUMN }],
  [1265, { kind: "invalid", column: NAMED_COLUMN }],
  [1292, { kind: "invalid", column: NAMED_COLUMN }],
  [1366, { kind: "invalid", column: NAMED_COLUMN }],
  [1406, { kind: "invalid", column: NAMED_COLUMN }],
  [3854, { kind: "invalid" }],
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
function Failure(
  mappings: ReadonlyMap<number, Mapping>,
  error: Error,
): ExternalFailure | undefined {
  const errno = ErrnoOf(error);
  const mapping = errno === undefined ? undefined : mappings.get(errno);
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

function MeasuresOf(flavour: Flavour): ExternalMeasureSyntax {
  const timeouts = [...flavour.readTimeoutErrnos, LOCK_WAIT_TIMEOUT];
  return {
    open: (timeoutMs) => [
      sql`SET SESSION ${flavour.readTimeout(timeoutMs)}`,
      sql`SET SESSION lock_wait_timeout = 1`,
      sql`SET SESSION innodb_lock_wait_timeout = 1`,
      sql`START TRANSACTION READ ONLY`,
    ],
    close: sql`ROLLBACK`,
    failure: (error) => {
      const errno = ErrnoOf(error);
      return {
        code: errno === undefined ? "unknown" : String(errno),
        timeout: errno !== undefined && timeouts.includes(errno),
      };
    },
    sampled: (key, every) => sql`(CRC32(${key}) % ${int(every)} = 0)`,
    sampledRandomly: (share) =>
      sql`(RAND(${int(SAMPLE_SEED)}) < ${param(share)})`,
    length: (text) => sql`CHAR_LENGTH(${text})`,
    bytes: (value) => sql`OCTET_LENGTH(${value})`,
    month: (instant) => sql`DATE_FORMAT(${instant}, '%Y-%m')`,
  };
}

export function ExternalOf(flavour: Flavour): ExternalSyntax {
  const { errno, named } = flavour.checkViolation;
  const mappings = new Map(MAPPINGS).set(errno, {
    kind: "check",
    constraint: named,
  });
  return {
    engine: flavour.id,
    catalog: ExternalCatalogOf(flavour),
    types: TypesOf(flavour),
    measures: MeasuresOf(flavour),
    failure: (error) => Failure(mappings, error),
  };
}
