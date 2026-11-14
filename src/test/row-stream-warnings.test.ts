import { expect } from "chai";

import { Bind, type Sql, param, sql } from "../statement";
import { AcquireConnection, GetDialect, Read } from "../connection";
import { OpenRowStream } from "../implementations/database/row-stream";

const BATCH = 10;

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
