import { expect } from "chai";

import { Bind, type Sql, type SqlValue } from "../../statement";
import type { Row } from "../../connection";
import { DIALECTS } from "../../dialect";
import type { ConvergenceSession } from "../../implementations/database/locks";
import { ReapInterval, ReapOnce } from "../../implementations/database/reaper";
import { SequenceOnce } from "../../implementations/database/sequencer";

const MYSQL = DIALECTS.mysql;
const RETENTION_MS = 300_000;

type Cell = string | number | null;

/** What one statement a session ran was, read off its text. */
const KINDS: readonly (readonly [string, RegExp])[] = [
  ["present", /information_schema\.TABLES/],
  ["database", /DATABASE\(\) AS name/],
  ["lock", /GET_LOCK/],
  ["unlock", /RELEASE_LOCK/],
  ["isolation", /^SET TRANSACTION/],
  ["begin", /^START TRANSACTION/],
  ["commit", /^COMMIT/],
  ["rollback", /^ROLLBACK/],
  ["clock", /__antelope_change_clock.*FOR UPDATE/],
  ["unsequenced", /IS NULL ORDER BY/],
  ["stamp", /JSON_TABLE/],
  ["advance", /^UPDATE `__antelope_change_clock`/],
  ["through", /AS through/],
  ["raise", /^INSERT INTO `__antelope_change_reaped`/],
  ["reap", /^DELETE FROM `__antelope_changes`/],
];

function KindOf(text: string): string {
  return KINDS.find(([, pattern]) => pattern.test(text))?.[0] ?? text;
}

interface Asked {
  readonly kind: string;
  readonly text: string;
  readonly args: readonly SqlValue[];
}

/** What a statement of one kind answers: rows for a read, a row count for a write. */
interface Answers {
  readonly rows?: Partial<Record<string, readonly Record<string, Cell>[][]>>;
  readonly counts?: Partial<Record<string, readonly number[]>>;
  readonly fails?: string;
}

function Rows(objects: readonly Record<string, Cell>[]): Row[] {
  return objects.map((object) => new Map(Object.entries(object)));
}

/**
 * A session that records every statement and answers each kind from a queue, the last answer of a
 * queue repeating; a kind with no queue answers no row and a count of 0.
 */
function Recording(answers: Answers) {
  const asked: Asked[] = [];
  const seen = new Map<string, number>();
  function Next<T>(queue: readonly T[] | undefined, kind: string, none: T): T {
    const index = seen.get(kind) ?? 0;
    seen.set(kind, index + 1);
    return queue?.[Math.min(index, queue.length - 1)] ?? none;
  }
  function Record(statement: Sql): string {
    const bound = Bind(statement);
    const kind = KindOf(bound.sql);
    asked.push({ kind, text: bound.sql, args: bound.args });
    if (answers.fails === kind) {
      throw new Error(`the ${kind} statement failed`);
    }
    return kind;
  }
  const session: ConvergenceSession = {
    id: 0,
    read: (statement) =>
      Promise.resolve().then(() => {
        const kind = Record(statement);
        return Rows(Next(answers.rows?.[kind], kind, []));
      }),
    apply: (statement) =>
      Promise.resolve().then(() => {
        Record(statement);
        return 0;
      }),
    write: (statement) =>
      Promise.resolve().then(() => {
        const kind = Record(statement);
        return Next(answers.counts?.[kind], kind, 0);
      }),
  };
  return { session, kinds: () => asked.map((one) => one.kind), asked };
}

const PRESENT = [[{ kind: "BASE TABLE", comment: "" }]];
const DATABASE = [[{ name: "shop" }]];
const TAKEN = [[{ acquired: 1 }]];
const HELD = [[{ acquired: 0 }]];
const NOTHING_OLD = [[{ through: null }]];

const SKIPPED_PASS = ["isolation", "begin", "clock", "commit"];

describe("a sequencer pass", () => {
  it("numbers the rows it locked from the clock, in the order they were logged", async () => {
    const { session, asked } = Recording({
      rows: {
        clock: [[{ next_seq: "41", epoch: "e" }]],
        unsequenced: [[{ id: "7" }, { id: "9" }, { id: "12" }]],
      },
    });
    expect(await SequenceOnce(session, MYSQL, "skip")).to.equal(3);
    const stamp = asked.find((one) => one.kind === "stamp");
    expect(stamp?.args).to.deep.equal(['["7","9","12"]', "41"]);
    const advance = asked.find((one) => one.kind === "advance");
    expect(advance?.text).to.contain("+ 3 ");
    expect(asked.map((one) => one.kind)).to.deep.equal([
      "isolation",
      "begin",
      "clock",
      "unsequenced",
      "stamp",
      "advance",
      "commit",
    ]);
  });

  it("leaves the log to a pass another session is running, numbering nothing", async () => {
    const { session, kinds } = Recording({});
    expect(await SequenceOnce(session, MYSQL, "skip")).to.equal(undefined);
    expect(kinds()).to.deep.equal(SKIPPED_PASS);
  });

  it("moves no clock when no committed row waits", async () => {
    const { session, kinds } = Recording({
      rows: { clock: [[{ next_seq: "1", epoch: "e" }]] },
    });
    expect(await SequenceOnce(session, MYSQL, "skip")).to.equal(0);
    expect(kinds()).to.not.include("stamp");
    expect(kinds()).to.not.include("advance");
  });

  it("rolls back a pass that fails, so no row keeps a number the clock did not move past", async () => {
    const { session, kinds } = Recording({
      rows: {
        clock: [[{ next_seq: "1", epoch: "e" }]],
        unsequenced: [[{ id: "1" }]],
      },
      fails: "advance",
    });
    await SequenceOnce(session, MYSQL, "skip").then(
      () => expect.fail("the pass should have failed"),
      () => undefined,
    );
    expect(kinds().slice(-2)).to.deep.equal(["advance", "rollback"]);
  });
});

describe("the change log's reaper", () => {
  it("does nothing at all against a database no owned schema was registered on", async () => {
    const { session, kinds } = Recording({});
    expect(await ReapOnce(session, MYSQL, RETENTION_MS)).to.equal(false);
    expect(kinds()).to.deep.equal(["present"]);
  });

  it("does not reap when another process holds the lock, and does not release it either", async () => {
    const { session, kinds } = Recording({
      rows: { present: PRESENT, database: DATABASE, lock: HELD },
    });
    expect(await ReapOnce(session, MYSQL, RETENTION_MS)).to.equal(false);
    expect(kinds()).to.deep.equal(["present", "database", "lock"]);
  });

  it("numbers what committed, raises the high-water, deletes, then releases, in that order", async () => {
    const { session, kinds } = Recording({
      rows: {
        present: PRESENT,
        database: DATABASE,
        lock: TAKEN,
        through: [[{ through: "7" }]],
      },
      counts: { reap: [3] },
    });
    expect(await ReapOnce(session, MYSQL, RETENTION_MS)).to.equal(true);
    expect(kinds()).to.deep.equal([
      "present",
      "database",
      "lock",
      ...SKIPPED_PASS,
      "isolation",
      "begin",
      "through",
      "raise",
      "reap",
      "commit",
      "unlock",
    ]);
  });
});

describe("a reaper pass", () => {
  it("raises and deletes through the same seq", async () => {
    const { session, asked } = Recording({
      rows: {
        present: PRESENT,
        database: DATABASE,
        lock: TAKEN,
        through: [[{ through: "7" }]],
      },
    });
    await ReapOnce(session, MYSQL, RETENTION_MS);
    const raise = asked.find((one) => one.kind === "raise");
    const reap = asked.find((one) => one.kind === "reap");
    expect(raise?.args).to.deep.equal(["7"]);
    expect(reap?.args).to.deep.equal(["7"]);
  });

  it("raises and deletes nothing when no numbered row is past its retention", async () => {
    const { session, kinds } = Recording({
      rows: {
        present: PRESENT,
        database: DATABASE,
        lock: TAKEN,
        through: NOTHING_OLD,
      },
    });
    await ReapOnce(session, MYSQL, RETENTION_MS);
    expect(kinds()).to.not.include("raise");
    expect(kinds()).to.not.include("reap");
    expect(kinds().at(-1)).to.equal("unlock");
  });

  it("keeps reaping while a batch comes back full", async () => {
    const { session, kinds } = Recording({
      rows: {
        present: PRESENT,
        database: DATABASE,
        lock: TAKEN,
        through: [[{ through: "20000" }], [{ through: "20004" }]],
      },
      counts: { reap: [10_000, 4] },
    });
    await ReapOnce(session, MYSQL, RETENTION_MS);
    expect(kinds().filter((kind) => kind === "reap")).to.have.length(2);
  });

  it("gives the lock back when the pass itself throws, which is the path that matters", async () => {
    const { session, kinds } = Recording({
      rows: {
        present: PRESENT,
        database: DATABASE,
        lock: TAKEN,
        through: [[{ through: "7" }]],
      },
      fails: "reap",
    });
    await ReapOnce(session, MYSQL, RETENTION_MS).then(
      () => expect.fail("the pass should have raised"),
      () => undefined,
    );
    expect(kinds().slice(-3)).to.deep.equal(["reap", "rollback", "unlock"]);
  });

  it("takes and gives back the same lock, scoped to the database", async () => {
    const { session, asked } = Recording({
      rows: { present: PRESENT, database: DATABASE, lock: TAKEN },
    });
    await ReapOnce(session, MYSQL, RETENTION_MS);
    const named = (kind: string) =>
      /'([^']+)'/.exec(asked.find((one) => one.kind === kind)?.text ?? "")?.[1];
    expect(named("lock")).to.match(/^ajs:reaper:/);
    expect(named("unlock")).to.equal(named("lock"));
  });

  it("counts the retention it was handed rather than reading the configuration mid-pass", async () => {
    const { session, asked } = Recording({
      rows: {
        present: PRESENT,
        database: DATABASE,
        lock: TAKEN,
        through: NOTHING_OLD,
      },
    });
    await ReapOnce(session, MYSQL, 1234);
    const through = asked.find((one) => one.kind === "through");
    expect(through?.text).to.contain("INTERVAL 1234000 MICROSECOND");
  });

  it("gives a retention window two passes, and never a zero interval", () => {
    expect(ReapInterval(300_000)).to.equal(150_000);
    expect(ReapInterval(1)).to.equal(1);
  });
});
