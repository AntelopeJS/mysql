import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

import { ident, int, sql } from "../statement";
import { AcquireConnection, Read } from "../connection";
import { WaitForSchemaReady } from "../implementations/database/schema";
import { Numbers, PhysicalTable, Run } from "./tables";
import { Pause } from "./watch";

interface Item {
  _id: string;
  n?: number;
  g?: number;
}

const SCHEMA_ID = "write-contention";
const WRITERS = 20;

/** The rows a table holds once seeded, unless a test asks for more. */
const SEEDED = 1000;

/** The rows the nested target selects out of the thousand the table holds. */
const NESTED_ROWS = 200;

/** The lowest `n` the nested deletes select, past every row the nested updates select. */
const DELETED_FROM = 900;

/** The rows each writer of a claim queue takes. */
const CLAIMED = 5;

/** More rows than a write split into statements of a thousand keys would change in one. */
const PAST_ONE_STATEMENT = 1500;

/** Long enough for an update to reach the row lock it waits on. */
const LOCK_REACHED_MS = 300;

const contended = new Schema<{ items: Item; sorted: Item }>(SCHEMA_ID, {
  items: { fields: { n: "number", g: "number" }, indexes: {} },
  sorted: { fields: { n: "number", g: "number" }, indexes: { n: {} } },
});
const items = () => contended.instance().table("items");
const sorted = () => contended.instance().table("sorted");
const table = (name = "items") => ident(PhysicalTable(SCHEMA_ID, name));

function Failures(outcomes: PromiseSettledResult<unknown>[]): string[] {
  return outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [String(outcome.reason)] : [],
  );
}

/**
 * The thousand rows of the indexed table, sorted by the index ascending for writer `i` and
 * descending for the next, as the block a later `filter` nests.
 */
function SortedBy(i: number) {
  return sorted()
    .orderBy("n", i % 2 === 0 ? "asc" : "desc")
    .slice(0, SEEDED);
}

/** Fills `name` with `rows` rows, `n` from 0 up, and no `g`. */
async function Seeded(name: string, rows = SEEDED): Promise<void> {
  await WaitForSchemaReady(SCHEMA_ID);
  await Run(sql`DELETE FROM ${table(name)}`);
  await Run(
    sql`INSERT INTO ${table(name)} (_id, _instance, n) SELECT LPAD(n, 4, '0'), '', n FROM ${Numbers(4)} AS numbers WHERE n < ${int(rows)}`,
  );
}

/** A write's answer and the rows per `g` it left, or the errno the server refused it with. */
type WriteOutcome =
  | { readonly answer: number; readonly groups: readonly string[][] }
  | { readonly refused: string };

async function Outcome(write: () => Promise<number>): Promise<WriteOutcome> {
  try {
    const answer = await write();
    const rows = await Read(
      sql`SELECT g, COUNT(*) AS c FROM ${table()} GROUP BY g ORDER BY g`,
    );
    const groups = rows.map((row) => [
      String(row.get("g")),
      String(row.get("c")),
    ]);
    return { answer, groups };
  } catch (err) {
    const errno = err instanceof Error && "errno" in err ? err.errno : err;
    return { refused: String(errno) };
  }
}

describe("writes that contend for rows", function () {
  this.timeout(60_000);

  beforeEach(() => Seeded("items"));

  it("runs an update again when another transaction deadlocks it", async () => {
    const other = await AcquireConnection();
    try {
      await Run(sql`START TRANSACTION`, other);
      await Run(
        sql`UPDATE ${table()} SET n = n + 1 WHERE _instance = '' AND _id >= '0100'`,
        other,
      );
      const update = items()
        .getAll(["0000", "0500"])
        .update({ n: -1 })
        .run()
        .then(
          (count) => count,
          (err: unknown) => String(err),
        );
      await Pause(LOCK_REACHED_MS);
      await Run(
        sql`UPDATE ${table()} SET n = n + 1 WHERE _instance = '' AND _id = '0000'`,
        other,
      );
      await Run(sql`COMMIT`, other);
      expect(await update).to.equal(2);
    } finally {
      other.release();
    }
  });

  it("lets concurrent updates and deletes of overlapping rows all succeed", async () => {
    const outcomes = await Promise.allSettled([
      ...Array.from({ length: WRITERS }, (_, i) =>
        items()
          .filter((row) => row.key("n").ge(0))
          .update({ n: i + 1 })
          .run(),
      ),
      ...Array.from({ length: WRITERS }, (_, i) =>
        items()
          .filter((row) => row.key("_id").ge(String(i * 50).padStart(4, "0")))
          .delete()
          .run(),
      ),
    ]);
    expect(Failures(outcomes)).to.deep.equal([]);
    expect(await items().count().run()).to.equal(0);
  });

  /**
   * A filter after a slice reads the table in a block nested inside the write's own read. A block
   * that read shared would leave every writer holding a shared lock that another waits to upgrade.
   */
  it("applies every write through a target nested in the read, from writers ordering it either way", async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: WRITERS }, (_, i) =>
        items()
          .orderBy("n", i % 2 === 0 ? "asc" : "desc")
          .slice(0, SEEDED)
          .filter((row) => row.key("n").lt(NESTED_ROWS))
          .update((row) => ({ g: row.key("g").default(0).add(1) }))
          .run(),
      ),
    );
    expect(Failures(outcomes)).to.deep.equal([]);
    const written = await items()
      .filter((row) => row.key("g").eq(WRITERS))
      .count()
      .run();
    expect(written).to.equal(NESTED_ROWS);
  });

  it("applies every increment that concurrent mapper updates of one row answer", async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: WRITERS }, () =>
        items()
          .get("0000")
          .update((row) => ({ n: row.key("n").add(1) }))
          .run(),
      ),
    );
    expect(Failures(outcomes)).to.deep.equal([]);
    const answers = outcomes.map((outcome) =>
      outcome.status === "fulfilled" ? outcome.value : undefined,
    );
    expect(answers).to.deep.equal(Array.from({ length: WRITERS }, () => 1));
    expect(await items().get("0000").run()).to.deep.equal({
      _id: "0000",
      n: WRITERS,
    });
  });
});

describe("writes through a nested target over an indexed sort", function () {
  this.timeout(60_000);

  beforeEach(() => Seeded("sorted"));

  /**
   * With an index on the sort, the nested block reads the table in index order, ascending for one
   * writer and descending for the next. A write that locked rows as that block reached them would
   * deadlock past its retries.
   */
  it("applies every write through a nested target over an indexed sort, from writers sorting it either way", async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: WRITERS }, (_, i) =>
        SortedBy(i)
          .filter((row) => row.key("n").lt(NESTED_ROWS))
          .update((row) => ({ g: row.key("g").default(0).add(1) }))
          .run(),
      ),
    );
    expect(Failures(outcomes)).to.deep.equal([]);
    const written = await sorted()
      .filter((row) => row.key("g").eq(WRITERS))
      .count()
      .run();
    expect(written).to.equal(NESTED_ROWS);
  });

  /**
   * Updaters select the first rows and deleters the last, each through a nested block that reads the
   * whole table in index order, ascending for one writer and descending for the next, so they lock
   * rows in opposite orders. A nested block that read its rows shared, or a deadlock run again at
   * once or only a few times, would surface one.
   */
  it("applies nested updates and deletes of different rows at once", async () => {
    const outcomes = await Promise.allSettled([
      ...Array.from({ length: WRITERS }, (_, i) =>
        SortedBy(i)
          .filter((row) => row.key("n").lt(NESTED_ROWS))
          .update((row) => ({ g: row.key("g").default(0).add(1) }))
          .run(),
      ),
      ...Array.from({ length: WRITERS }, (_, i) =>
        SortedBy(i)
          .filter((row) => row.key("n").ge(DELETED_FROM + i))
          .delete()
          .run(),
      ),
    ]);
    expect(Failures(outcomes)).to.deep.equal([]);
    const written = await sorted()
      .filter((row) => row.key("g").eq(WRITERS))
      .count()
      .run();
    expect(written).to.equal(NESTED_ROWS);
    const left = await sorted()
      .filter((row) => row.key("n").ge(DELETED_FROM))
      .count()
      .run();
    expect(left).to.equal(0);
  });

  /**
   * Every writer selects the rows whose `g` is unset, and sets it. The first to hold them sets them,
   * and every later one finds them gone from its selection once it holds them. A write that changed
   * the rows a read selected before it locked them would set them again.
   */
  it("writes no row that left a nested target while the write waited for it", async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: WRITERS }, (_, i) =>
        SortedBy(i)
          .filter((row) => row.key("n").lt(NESTED_ROWS))
          .filter((row) => row.key("g").default(0).eq(0))
          .update((row) => ({ g: row.key("g").default(0).add(1) }))
          .run(),
      ),
    );
    expect(Failures(outcomes)).to.deep.equal([]);
    const answers = outcomes.map((outcome) =>
      outcome.status === "fulfilled" ? outcome.value : 0,
    );
    expect(answers.reduce((sum, answer) => sum + answer, 0)).to.equal(
      NESTED_ROWS,
    );
    const once = await sorted()
      .filter((row) => row.key("g").eq(1))
      .count()
      .run();
    expect(once).to.equal(NESTED_ROWS);
  });

  /**
   * Every writer claims the five lowest unclaimed rows, which other writers keep claiming first. A
   * nested block that read the rows without locking them would select rows another writer holds and
   * then finds claimed, or a write that locked its selection a fixed number of rounds would stop
   * short, and either would answer fewer than five.
   */
  it("claims as many rows as a queue taken one writer at a time, through a nested target", async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: WRITERS }, () =>
        sorted()
          .filter((row) => row.key("g").default(0).eq(0))
          .orderBy("n")
          .slice(0, CLAIMED)
          .filter((row) => row.key("n").ge(0))
          .update({ g: 1 })
          .run(),
      ),
    );
    expect(Failures(outcomes)).to.deep.equal([]);
    const answers = outcomes.map((outcome) =>
      outcome.status === "fulfilled" ? outcome.value : 0,
    );
    expect(answers).to.deep.equal(
      Array.from({ length: WRITERS }, () => CLAIMED),
    );
    const claimed = await sorted()
      .filter((row) => row.key("g").eq(1))
      .count()
      .run();
    expect(claimed).to.equal(WRITERS * CLAIMED);
  });

  /**
   * `orderBy` and `slice` fold into the table's own block, so the write reads it in one block, in
   * index order, ascending for one writer and descending for the next, and they lock rows in
   * opposite orders. A deadlock run again at once, or only three times in all, would surface.
   */
  it("applies every write through a sorted and sliced target, from writers sorting it either way", async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: WRITERS }, (_, i) =>
        SortedBy(i)
          .update((row) => ({ g: row.key("g").default(0).add(1) }))
          .run(),
      ),
    );
    expect(Failures(outcomes)).to.deep.equal([]);
    const written = await sorted()
      .filter((row) => row.key("g").eq(WRITERS))
      .count()
      .run();
    expect(written).to.equal(SEEDED);
  });
});

describe("a write through a nested target of many rows", function () {
  this.timeout(60_000);

  beforeEach(() => Seeded("items", PAST_ONE_STATEMENT));

  /**
   * Each row is set to how many rows have no `g` yet, which is every row before the write. A write
   * that changed the rows in several statements would give the rows of each later statement the
   * count left after the earlier ones. MySQL refuses a write that reads the table it changes, and
   * must refuse it through either target.
   */
  it("writes what the same write through a flat target writes", async () => {
    const unset = () =>
      items()
        .filter((row) => row.key("g").default(0).eq(0))
        .count();
    const flat = await Outcome(() =>
      items()
        .update(() => ({ g: unset() }))
        .run(),
    );
    await Seeded("items", PAST_ONE_STATEMENT);
    const nested = await Outcome(() =>
      items()
        .orderBy("n")
        .slice(0, 2 * PAST_ONE_STATEMENT)
        .filter((row) => row.key("n").ge(0))
        .update(() => ({ g: unset() }))
        .run(),
    );
    expect(nested).to.deep.equal(flat);
  });
});

/** Enough rows that twenty writers sorting both ways keep meeting while they scan. */
const COMPUTED_ROWS = 9000;

/** The rows the writers through a computed bound select out of those. */
const COMPUTED_PICKED = 500;

/** How many times the twenty writers run, each over freshly seeded rows. */
const COMPUTED_ROUNDS = 5;

describe("writes through a slice whose bound the query computes", function () {
  this.timeout(180_000);

  /**
   * A bound the query computes numbers the rows in a block of its own, which wraps the table's
   * block. A numbering block that left out the table block's lock would read the rows shared, and
   * writers sorting both ways would deadlock upgrading each other's shared locks past every retry.
   */
  it("applies every write from twenty writers sorting the table either way", async () => {
    await Seeded("items", COMPUTED_ROWS);
    for (let round = 0; round < COMPUTED_ROUNDS; round += 1) {
      await Seeded("sorted", COMPUTED_ROWS);
      const outcomes = await Promise.allSettled(
        Array.from({ length: WRITERS }, (_, i) =>
          sorted()
            .orderBy("n", i % 2 === 0 ? "asc" : "desc")
            .slice(0, items().count())
            .filter((row) => row.key("n").lt(COMPUTED_PICKED))
            .update((row) => ({ g: row.key("g").default(0).add(1) }))
            .run(),
        ),
      );
      expect(Failures(outcomes)).to.deep.equal([]);
      const written = await sorted()
        .filter((row) => row.key("g").eq(WRITERS))
        .count()
        .run();
      expect(written).to.equal(COMPUTED_PICKED);
    }
  });
});
