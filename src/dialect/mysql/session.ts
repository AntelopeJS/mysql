import { createHash } from "node:crypto";

import type { SessionSettings, SessionSyntax } from "../types";
import type { Flavour } from "./flavour";
import {
  MAX_IDENTIFIER_CHARS,
  type Sql,
  int,
  join,
  lit,
  sql,
} from "../../statement";

/**
 * Strict for every table, so a value a column cannot hold fails its statement; no zero dates. Left
 * out on purpose: `NO_BACKSLASH_ESCAPES` (string literals escape backslashes), `PIPES_AS_CONCAT`
 * (`||` stays OR and is never emitted), `ANSI_QUOTES` (identifiers are backticked) and
 * `ONLY_FULL_GROUP_BY`.
 */
const SQL_MODE =
  "STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION";

/** Server messages that are parsed for a key or column name stay in English whatever the server's language. */
const MESSAGES = "en_US";

const UTC = "+00:00";

/** InnoDB's key length limit with the DYNAMIC row format, in bytes. */
const KEY_BUDGET_BYTES = 3072;

/** InnoDB's limit on the columns of one index, `MAX_REF_PARTS`. */
const MAX_KEY_COLUMNS = 16;

const LOCK_VENDOR = "ajs";
const LOCK_SEPARATOR = ":";
const LOCK_DIGEST_CHARS = 40;
const LOCK_PURPOSE = /^[a-z]+$/;
const LOCK_PURPOSE_MAX_CHARS =
  MAX_IDENTIFIER_CHARS -
  LOCK_VENDOR.length -
  2 * LOCK_SEPARATOR.length -
  LOCK_DIGEST_CHARS;

function Pin(flavour: Flavour, settings: SessionSettings): Sql {
  const assignments = [
    sql`NAMES utf8mb4 COLLATE ${lit(flavour.binaryCollation)}`,
    sql`time_zone = ${lit(UTC)}`,
    sql`sql_mode = ${lit(SQL_MODE)}`,
    sql`lc_messages = ${lit(MESSAGES)}`,
    ...flavour.pinned,
  ];
  if (settings.statementTimeoutMs !== undefined) {
    assignments.push(flavour.readTimeout(settings.statementTimeoutMs));
  }
  return sql`SET ${join(assignments, sql`, `)}`;
}

function LockName(purpose: string, scope: string): string {
  if (!LOCK_PURPOSE.test(purpose) || purpose.length > LOCK_PURPOSE_MAX_CHARS) {
    throw new Error(
      `Lock purpose '${purpose}' must be lowercase letters, at most ${LOCK_PURPOSE_MAX_CHARS} of them`,
    );
  }
  const digest = createHash("sha256")
    .update(scope)
    .digest("hex")
    .slice(0, LOCK_DIGEST_CHARS);
  return [LOCK_VENDOR, purpose, digest].join(LOCK_SEPARATOR);
}

export function SessionOf(flavour: Flavour): SessionSyntax {
  return {
    pin: (settings) => Pin(flavour, settings),
    statementTimeout: (ms) => sql`SET SESSION ${flavour.readTimeout(ms)}`,
    binaryCollation: flavour.binaryCollation,
    keyBudgetBytes: KEY_BUDGET_BYTES,
    maxKeyColumns: MAX_KEY_COLUMNS,
    multiValuedIndex: flavour.multiValuedIndex,
    lockName: LockName,
    acquireLock: (name, waitSeconds) =>
      sql`SELECT GET_LOCK(${lit(name)}, ${int(waitSeconds)}) AS acquired`,
    releaseLock: (name) => sql`SELECT RELEASE_LOCK(${lit(name)}) AS released`,
  };
}
