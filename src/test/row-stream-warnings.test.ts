import { expect } from "chai";

import { Bind, type Sql, ident, int, param, sql } from "../statement";
import { AcquireConnection, GetDialect, Read } from "../connection";
import { OpenRowStream } from "../implementations/database/row-stream";
import { Run } from "./tables";

const BATCH = 10;

/** More rows than the 64 warnings MariaDB lists for a statement by default, each raising one. */
const PAST_LISTED = 1000;

/** How many times a cursor reads rows that another connection flips meanwhile. */
const RACED_RUNS = 60;

/** The errno MariaDB fails a statement with past `max_statement_time`. */
const STATEMENT_TIMEOUT = 1969;

/** Deeper than MariaDB 11.8 builds, so a JSON function answers it as SQL NULL with warning 4040. */
const TOO_DEEP = `${"[".repeat(40)}${"]".repeat(40)}`;

interface Drained {
  readonly seqs: readonly number[];
  readonly nulls: number;
  readonly failure?: unknown;
}

/** Each row's `seq` a cursor's stream hands over, how many held a NULL `j`, and its failure. */
async function Drained(statement: Sql): Promise<Drained> {
  const source = await OpenRowStream(statement, BATCH);
  const seqs: number[] = [];
  let nulls = 0;
  let isEnded = false;
  try {
    while (!isEnded) {
      const rows = await source.next(BATCH);
      for (const row of rows) {
        seqs.push(Number(row.get("seq")));
        nulls += row.get("j") === null ? 1 : 0;
      }
      isEnded = rows.length < BATCH;
    }
    return { seqs, nulls };
  } catch (failure) {
    return { seqs, nulls, failure };
  } finally {
    await source.close();
  }
}

describe("a cursor's stream over a statement that raises many warnings", function () {
  this.timeout(30_000);

  before(function () {
    if (!GetDialect().capture.warnings) {
      this.skip();
    }
  });

  /**
   * Every row raises a truncation warning first, so MariaDB lists only the first 64 and not the
   * 4040 of the last row; a cursor that read the warnings it lists as all it raised would hand
   * the NULL over as the last row's value.
   */
  it("hands over no row read wrong past the warnings MariaDB lists", async () => {
    const { seqs, nulls, failure } = await Drained(
      sql`SELECT s.seq AS seq, CAST(CONCAT(s.seq, 'x') AS INT) AS c, IF(s.seq = 100, JSON_EXTRACT(${param(TOO_DEEP)}, '$'), JSON_ARRAY()) AS j FROM seq_1_to_100 AS s ORDER BY s.seq`,
    );
    expect({
      nulls,
      isAnswered: failure !== undefined || seqs.length === 100,
    }).to.deep.equal({ nulls: 0, isAnswered: true });
  });

  /**
   * Every row raises a truncation warning first, more than the 64 MariaDB lists by default, so a
   * session that kept that default would not list the 4040 of the last row and the read would
   * answer the NULL as the last row's value.
   */
  it("answers no read with a row read wrong past the warnings MariaDB lists", async () => {
    const answer = await Read(
      sql`SELECT s.seq AS seq, CAST(CONCAT(s.seq, 'x') AS INT) AS c, IF(s.seq = ${int(PAST_LISTED)}, JSON_EXTRACT(${param(TOO_DEEP)}, '$'), JSON_ARRAY()) AS j FROM seq_1_to_${int(PAST_LISTED)} AS s ORDER BY s.seq`,
    ).then(
      (rows) => ({
        nulls: rows.filter((row) => row.get("j") === null).length,
        isAnswered: rows.length === PAST_LISTED,
      }),
      () => ({ nulls: 0, isAnswered: true }),
    );
    expect(answer).to.deep.equal({ nulls: 0, isAnswered: true });
  });

  /**
   * Each row raises a truncation warning, more than the 64 MariaDB lists by default; a read that
   * failed where its default list ran out would refuse rows it read whole.
   */
  it("answers a read whose many warnings MariaDB lists", async () => {
    const rows = await Read(
      sql`SELECT s.seq AS seq, CAST(CONCAT(s.seq, 'x') AS INT) AS c, JSON_ARRAY() AS j FROM seq_1_to_1000 AS s ORDER BY s.seq`,
    );
    expect(rows.length).to.equal(1000);
  });

  /**
   * Each row raises a truncation warning, as many as MariaDB lists; a cursor that counted the
   * check's own error among the warnings it cannot read would refuse rows a plain read answers.
   */
  it("answers every row where MariaDB lists every warning its statement raised", async () => {
    const { seqs, failure } = await Drained(
      sql`SELECT s.seq AS seq, CAST(CONCAT(s.seq, 'x') AS INT) AS c, JSON_ARRAY() AS j FROM seq_1_to_64 AS s ORDER BY s.seq`,
    );
    expect({ rows: seqs.length, failure }).to.deep.equal({
      rows: 64,
      failure: undefined,
    });
  });

  /**
   * The read warns of a too-deep document, then runs past its timeout; a read that reported the
   * listed warning in place of the server's error would hide the timeout.
   */
  it("keeps the timeout of a read that warned of a too-deep document first", async () => {
    const held = await AcquireConnection();
    try {
      const timeout = Bind(sql`SET SESSION max_statement_time = 1`);
      await held.execute(timeout.sql, [...timeout.args]);
      const failure = await Read(
        sql`SELECT s.seq AS seq, IF(s.seq = 1, JSON_EXTRACT(${param(TOO_DEEP)}, '$'), JSON_ARRAY()) AS j, SLEEP(0.05) AS z FROM seq_1_to_100 AS s ORDER BY s.seq`,
        held,
      ).then(
        () => "answered",
        (err: unknown) =>
          err instanceof Error && "errno" in err ? err.errno : "no errno",
      );
      expect(failure).to.equal(STATEMENT_TIMEOUT);
    } finally {
      held.destroy();
    }
  });

  /**
   * The statement streams as it is and fails at its 150th row after a warning on each row before;
   * a cursor that read that failure as its check's would run it again, handing its first rows over
   * twice, or report the warnings MariaDB does not list in its place.
   */
  it("hands each row over once where its statement fails partway", async () => {
    const { seqs, failure } = await Drained(
      sql`SELECT s.seq AS seq, CAST(CONCAT(s.seq, 'x') AS INT) AS c, (SELECT 1 FROM seq_1_to_2 AS d WHERE s.seq >= 150) AS t FROM seq_1_to_200 AS s`,
    );
    expect({
      isOnce: new Set(seqs).size === seqs.length,
      failure: failure instanceof Error ? failure.message : failure,
    }).to.deep.equal({
      isOnce: true,
      failure: "Subquery returns more than 1 row",
    });
  });
});

const FLIPPED = "row_stream_flipped";

/** Rows of which the fifth turns, at each flip, from a harmless warning to a too-deep document and back. */
async function Flippable(): Promise<void> {
  await Run(sql`DROP TABLE IF EXISTS ${ident(FLIPPED)}`);
  await Run(
    sql`CREATE TABLE ${ident(FLIPPED)} (seq INT PRIMARY KEY, s VARCHAR(20), d LONGTEXT) ENGINE = InnoDB`,
  );
  await Run(
    sql`INSERT INTO ${ident(FLIPPED)} SELECT seq, IF(seq = 5, '5x', '1'), '[]' FROM seq_1_to_100`,
  );
}

/** Flips the fifth row on a connection of its own until `isDone` answers true. */
async function Flipping(isDone: () => boolean): Promise<void> {
  const held = await AcquireConnection();
  const flip = Bind(
    sql`UPDATE ${ident(FLIPPED)} SET d = IF(s = '5x', ${param(TOO_DEEP)}, '[]'), s = IF(s = '5x', '5', '5x') WHERE seq = 5`,
  );
  try {
    while (!isDone()) {
      await held.execute(flip.sql, [...flip.args]);
    }
  } finally {
    held.release();
  }
}

describe("a cursor's stream over rows a write changes between its two runs", function () {
  this.timeout(120_000);

  before(async function () {
    if (!GetDialect().capture.warnings) {
      this.skip();
    }
    await Flippable();
  });

  after(async () => {
    await Run(sql`DROP TABLE IF EXISTS ${ident(FLIPPED)}`);
  });

  /**
   * A first run that warns only of the fifth row's truncation runs again tolerating one warning;
   * a second run that read the rows a write had flipped since would answer the too-deep NULL
   * within that tolerance.
   */
  it("hands over no row read wrong", async () => {
    let isDone = false;
    const flipping = Flipping(() => isDone);
    const handed: number[] = [];
    try {
      for (let run = 0; run < RACED_RUNS; run += 1) {
        handed.push(
          (
            await Drained(
              sql`SELECT t.seq AS seq, CAST(t.s AS INT) AS c, JSON_EXTRACT(t.d, '$') AS j FROM ${ident(FLIPPED)} AS t ORDER BY t.seq`,
            )
          ).nulls,
        );
      }
    } finally {
      isDone = true;
      await flipping;
    }
    expect(handed.filter((nulls) => nulls > 0)).to.deep.equal([]);
  });
});

const DRAINED = "row_stream_drained";

/** How long an `ALTER` waits for a metadata lock before it fails, well under the test's timeout. */
const LOCK_WAIT_SECONDS = 3;

/** Whether an `ALTER` of {@link DRAINED} ran on a connection of its own while `source` stayed open. */
async function Altered(): Promise<string> {
  const held = await AcquireConnection();
  const alter = Bind(
    sql`SET STATEMENT lock_wait_timeout = ${int(LOCK_WAIT_SECONDS)} FOR ALTER TABLE ${ident(DRAINED)} FORCE`,
  );
  try {
    await held.execute(alter.sql, [...alter.args]);
    return "altered";
  } catch (err) {
    return err instanceof Error ? err.message : "no Error";
  } finally {
    held.release();
  }
}

describe("a checked cursor's stream read to its end and left open", function () {
  this.timeout(60_000);

  before(async function () {
    if (!GetDialect().capture.warnings) {
      this.skip();
    }
    await Run(sql`DROP TABLE IF EXISTS ${ident(DRAINED)}`);
    await Run(
      sql`CREATE TABLE ${ident(DRAINED)} (seq INT PRIMARY KEY, s VARCHAR(20)) ENGINE = InnoDB`,
    );
    await Run(
      sql`INSERT INTO ${ident(DRAINED)} VALUES (1, '1'), (2, '2x'), (3, '3')`,
    );
  });

  after(async () => {
    await Run(sql`DROP TABLE IF EXISTS ${ident(DRAINED)}`);
  });

  const STATEMENTS: ReadonlyArray<readonly [string, Sql]> = [
    [
      "raised no warning",
      sql`SELECT t.seq AS seq, JSON_ARRAY(t.seq) AS j FROM ${ident(DRAINED)} AS t WHERE t.seq <> 2`,
    ],
    [
      "raised a harmless warning",
      sql`SELECT t.seq AS seq, CAST(t.s AS INT) AS c, JSON_ARRAY(t.seq) AS j FROM ${ident(DRAINED)} AS t`,
    ],
  ];

  for (const [name, statement] of STATEMENTS) {
    /**
     * Fails where the cursor holds its tables' metadata locks after its result has ended, as a
     * transaction it ends only when it closes does.
     */
    it(`lets DDL run where its statement ${name}`, async () => {
      const source = await OpenRowStream(statement, BATCH);
      try {
        const rows = await source.next(BATCH);
        expect({
          rows: rows.length > 0,
          altered: await Altered(),
        }).to.deep.equal({
          rows: true,
          altered: "altered",
        });
      } finally {
        await source.close();
      }
    });
  }
});
