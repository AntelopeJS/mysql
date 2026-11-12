/**
 * The statements of the change log, as `src/dialect/mysql/capture.ts` spells them, each turned
 * into one indivisible step on `InnoDb`, as one statement is on the server. A statement the table
 * does not know raises `ModelError`, so an edit to the SQL shows up as "could not run" until the
 * model learns it, never as a statement silently answered.
 */
import type { Bound } from "../../../src/statement";
import { IsString } from "../../../src/implementations/database/guards";
import { type InnoDb, ModelError } from "./innodb";
import {
  advance,
  constant,
  control,
  ending,
  frontier,
  getLock,
  lockClock,
  type Op,
  poll,
  raiseReaped,
  reap,
  reapThrough,
  releaseLock,
  row,
  type SessionState,
  stamp,
  text,
  unsequenced,
} from "./steps";

const LOG = "`__antelope_changes`";
const CLOCK = "`__antelope_change_clock`";
const REAPED = "`__antelope_change_reaped`";
const BIGINT_ARG = "CAST\\(\\? AS UNSIGNED\\)";

/** One pattern of the table: the statement it recognises and the step it becomes. */
type Parser = (match: RegExpExecArray, bound: Bound, db: InnoDb, session: SessionState) => Op;

const STATEMENTS: readonly (readonly [RegExp, Parser])[] = [
  [/^SET TRANSACTION ISOLATION LEVEL READ COMMITTED$/, () => control("read committed", () => undefined)],
  [/^START TRANSACTION$/, (_, __, db, session) => control("begin", () => (session.txn = db.begin()))],
  [/^COMMIT$/, (_, __, db, session) => ending(db, session, true)],
  [/^ROLLBACK$/, (_, __, db, session) => ending(db, session, false)],
  [
    new RegExp(`^SELECT \`next_seq\` AS next_seq, \`epoch\` AS epoch FROM ${CLOCK} WHERE \`id\` = 1( FOR UPDATE(?: SKIP LOCKED)?)?$`),
    (match, _, db) => lockClock(db, match[1]),
  ],
  [
    new RegExp(`^SELECT \`id\` AS id FROM ${LOG} WHERE \`seq\` IS NULL ORDER BY \`id\`( DESC)? LIMIT (\\d+)( FOR UPDATE(?: SKIP LOCKED)?)?$`),
    (match, _, db) => unsequenced(db, match[1] !== undefined, Number(match[2]), match[3]),
  ],
  [
    new RegExp(
      `^UPDATE ${LOG} AS c JOIN JSON_TABLE\\(\\?, '\\$\\[\\*\\]' COLUMNS \\(n FOR ORDINALITY, id BIGINT UNSIGNED PATH '\\$'\\)\\) AS v ON c\\.\`id\` = v\\.id SET c\\.\`seq\` = ${BIGINT_ARG} \\+ v\\.n - 1, c\\.\`sequenced_at\` = UTC_TIMESTAMP\\(6\\) WHERE c\\.\`id\` IN \\(${BIGINT_ARG}(?:, ${BIGINT_ARG})*\\)$`,
    ),
    (_, bound, db) => {
      const list: unknown = JSON.parse(text(bound.args[0], "the numbered ids"));
      if (!Array.isArray(list) || !list.every((id) => IsString(id))) {
        throw new ModelError("the numbered ids are not a JSON array of text");
      }
      const named = bound.args
        .slice(2)
        .map((id) => text(id, "an id the update names"));
      if (named.length !== list.length || named.some((id, at) => id !== list[at])) {
        throw new ModelError("the update names other rows than it numbers");
      }
      return stamp(db, list, BigInt(text(bound.args[1], "the first seq")));
    },
  ],
  [
    new RegExp(`^UPDATE ${CLOCK} SET \`next_seq\` = \`next_seq\` \\+ (\\d+) WHERE \`id\` = 1$`),
    (match, _, db) => advance(db, BigInt(match[1] ?? "0")),
  ],
  [
    new RegExp(
      `^SELECT \`epoch\` AS epoch, \`next_seq\` - 1 AS frontier, EXISTS \\(SELECT 1 FROM ${LOG} WHERE \`seq\` IS NULL\\) AS pending FROM ${CLOCK} WHERE \`id\` = 1$`,
    ),
    (_, __, db) => frontier(db),
  ],
  [
    new RegExp(
      `^SELECT MAX\\(b\\.\`seq\`\\) AS through FROM \\(SELECT \`seq\` FROM ${LOG} WHERE \`sequenced_at\` < UTC_TIMESTAMP\\(6\\) - INTERVAL (\\d+) MICROSECOND ORDER BY \`sequenced_at\` LIMIT (\\d+)\\) AS b$`,
    ),
    (match, _, db) => reapThrough(db, Number(match[1]), Number(match[2])),
  ],
  [
    new RegExp(
      `^INSERT INTO ${REAPED} \\(\`tbl\`, \`high_water\`\\) SELECT d\\.\`tbl\`, d\\.\`high_water\` FROM \\(SELECT \`tbl\`, MAX\\(\`seq\`\\) AS \`high_water\` FROM ${LOG} WHERE \`seq\` <= ${BIGINT_ARG} GROUP BY \`tbl\`\\) AS d ON DUPLICATE KEY UPDATE \`high_water\` = GREATEST\\(${REAPED}\\.\`high_water\`, d\\.\`high_water\`\\)$`,
    ),
    (_, bound, db) => raiseReaped(db, BigInt(text(bound.args[0], "the reaped seq"))),
  ],
  [
    new RegExp(`^DELETE FROM ${LOG} WHERE \`seq\` <= ${BIGINT_ARG}$`),
    (_, bound, db) => reap(db, BigInt(text(bound.args[0], "the reaped seq"))),
  ],
  [
    /^SELECT TABLE_TYPE AS kind, TABLE_COMMENT AS comment FROM information_schema\.TABLES WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = \?$/,
    (_, bound) =>
      constant(
        "read the log's catalog entry",
        bound.args[0] === "__antelope_changes" ? [row({ kind: "BASE TABLE", comment: "log" })] : [],
      ),
  ],
  [/^SELECT DATABASE\(\) AS name$/, () => constant("read the database name", [row({ name: "antelopejs" })])],
  [/^SELECT GET_LOCK\('([^']+)', 0\) AS acquired$/, (match, _, db, session) => getLock(db, session, match[1] ?? "")],
  [/^SELECT RELEASE_LOCK\('([^']+)'\) AS released$/, (match, _, db, session) => releaseLock(db, session, match[1] ?? "")],
  [
    new RegExp(
      `^SELECT c\\.epoch AS epoch, c\\.frontier AS frontier, c\\.high_water AS high_water, e\\.seq AS seq, e\\.op AS op, e\\.old_side AS old_side, e\\.new_side AS new_side FROM \\(SELECT k\\.\`epoch\` AS epoch, k\\.\`next_seq\` - 1 AS frontier, \\(SELECT r\\.\`high_water\` FROM ${REAPED} AS r WHERE r\\.\`tbl\` = \\?\\) AS high_water FROM ${CLOCK} AS k WHERE k\\.\`id\` = 1\\) AS c LEFT JOIN LATERAL \\(SELECT \`ev\`\\.\`seq\` AS seq, \`ev\`\\.\`op\` AS op, CASE WHEN \`ev\`\\.\`old_row\` IS NOT NULL THEN \\(.*\\) END AS old_side, CASE WHEN \`ev\`\\.\`new_row\` IS NOT NULL THEN \\(.*\\) END AS new_side FROM ${LOG} AS \`ev\` WHERE \`ev\`\\.\`tbl\` = \\?( AND \`ev\`\\.\`inst\` = \\?)? AND \`ev\`\\.\`seq\` > ${BIGINT_ARG} AND \`ev\`\\.\`seq\` <= c\\.frontier ORDER BY \`ev\`\\.\`seq\` LIMIT (\\d+)\\) AS e ON TRUE ORDER BY e\\.seq$`,
      "s",
    ),
    (match, bound, db) => poll(db, bound.args, match[1] !== undefined, Number(match[2])),
  ],
];

/** The step a bound statement is, or `ModelError` for a statement the table does not know. */
export function Parse(bound: Bound, db: InnoDb, session: SessionState): Op {
  const sql = bound.sql.trim();
  for (const [pattern, parser] of STATEMENTS) {
    const match = pattern.exec(sql);
    if (match) {
      return parser(match, bound, db, session);
    }
  }
  throw new ModelError(`the model does not know this statement: ${sql.slice(0, 200)}`);
}
