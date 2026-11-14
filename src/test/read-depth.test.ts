import { expect } from "chai";
import { setTimeout as delay } from "node:timers/promises";
import type { Stream } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";

import { param, sql } from "../statement";
import { AcquireConnection, GetDialect, Read } from "../connection";
import { GetOptions } from "../config";
import { Reconnect } from "./tables";
import { HandedOver, InBatchesOfOne } from "./batches";
import type { Nest, Row } from "./watch";

function Nested(levels: number): Nest {
  let value: Nest = "🦌 deep";
  for (let level = 0; level < levels; level += 1) {
    value = { n: value };
  }
  return value;
}

async function Nests(levels: number): Promise<boolean> {
  const text = `${"[".repeat(levels)}${"]".repeat(levels)}`;
  return Read(sql`SELECT JSON_VALID(${param(text)}) AS valid`).then(
    ([row]) => Number(row.get("valid")) === 1,
    () => false,
  );
}

/** The deepest document a column holds, as deep as the server validates. */
async function DeepestInColumn(): Promise<number> {
  let inColumn = 100;
  while (!(await Nests(inColumn))) {
    inColumn -= 1;
  }
  return inColumn;
}

/** The rows a read answered, `too deep` for the engine's too-deep error, or another error's text. */
type Answered = readonly Row[] | string;

/**
 * What a read of a row holding the deepest document, merged one level up, should answer: the row
 * merged where the server builds one level more, and the engine's too-deep error otherwise.
 */
async function Expected(inColumn: number): Promise<Answered> {
  return (await Nests(inColumn + 1))
    ? [{ _id: "deepest", label: "merged", tree: Nested(inColumn) }]
    : "too deep";
}

async function Answer(read: Promise<Row[]>): Promise<Answered> {
  return read.catch((err: unknown) =>
    err instanceof Error && GetDialect().capture.tooDeep(err)
      ? "too deep"
      : String(err),
  );
}

/**
 * How a cursor ended: `whole`, `short` where it ended without a failure before its last row, `too
 * deep` for the engine's too-deep error, or another error's text.
 */
function Ending(failure: unknown, isWhole: boolean): string {
  if (failure === undefined) {
    return isWhole ? "whole" : "short";
  }
  if (!(failure instanceof Error)) {
    return "a failure that is no Error";
  }
  return GetDialect().capture.tooDeep(failure) ? "too deep" : failure.message;
}

async function Iterated<T>(query: Stream<T>): Promise<T[]> {
  const read: T[] = [];
  for await (const value of query) {
    read.push(value);
  }
  return read;
}

const depth = new Schema<{ rows: Row }>("read-depth", {
  rows: { fields: { label: "string", tree: "object" }, indexes: {} },
});

const cursorDepth = new Schema<{ rows: Row }>("read-depth-cursor", {
  rows: { fields: { label: "string", tree: "object" }, indexes: {} },
});

const batchedDepth = new Schema<{ rows: Row }>("read-depth-batched", {
  rows: { fields: { label: "string", tree: "object" }, indexes: {} },
});

describe("a plain read that builds a document deeper than the server builds", function () {
  this.timeout(30_000);

  /**
   * MariaDB 11.8 answers SQL NULL with warning 4040 for such a document, so the read answered
   * `null` as the row where MySQL fails it.
   */
  it("fails with the engine's too-deep error, or answers the document where the server builds it", async () => {
    const inColumn = await DeepestInColumn();
    const rows = depth.instance().table("rows");
    await rows.insert({ _id: "deepest", tree: Nested(inColumn) }).run();
    const expected = await Expected(inColumn);
    expect(
      await Answer(rows.map((row) => row.merge({ label: "merged" })).run()),
    ).to.deep.equal(expected);
  });
});

const DEEP = sql`SELECT JSON_VALID(${param("[".repeat(100) + "]".repeat(100))}) AS valid`;

const TABLELESS = sql`SELECT 1 AS one`;

/** Long enough for a result of one row to end after the row was read. */
const END_ARRIVES_MS = 300;

function Ones(rows: readonly ReadonlyMap<string, unknown>[]): number[] {
  return rows.map((row) => Number(row.get("one")));
}

describe("a table-less read after a too-deep read on the same connection", function () {
  this.timeout(30_000);

  /**
   * MariaDB 11.8 keeps the too-deep read's warning 4040 listed through every statement that reads
   * no table, so a read that lists the warnings without clearing them fails the next one falsely.
   */
  it("answers its rows on a held connection", async () => {
    const held = await AcquireConnection();
    try {
      await Read(DEEP, held).catch(() => undefined);
      expect(Ones(await Read(TABLELESS, held))).to.deep.equal([1]);
    } finally {
      held.release();
    }
  });

  /** Fails where a pooled connection goes back to the pool still listing the warning. */
  it("answers its rows on pooled connections", async () => {
    for (let read = 0; read < 20; read += 1) {
      await Read(DEEP).catch(() => undefined);
      expect(Ones(await Read(TABLELESS))).to.deep.equal([1]);
    }
  });
});

describe("a cursor that builds a document deeper than the server builds", function () {
  this.timeout(30_000);

  let inColumn = 0;

  before(async () => {
    inColumn = await DeepestInColumn();
    await cursorDepth
      .instance()
      .table("rows")
      .insert({ _id: "deepest", tree: Nested(inColumn) })
      .run();
  });

  function Merged() {
    return cursorDepth
      .instance()
      .table("rows")
      .map((row) => row.merge({ label: "merged" }));
  }

  /**
   * MariaDB 11.8 answers SQL NULL with warning 4040 for such a document, so the cursor answered
   * `null` as the row where a plain read fails.
   */
  it("fails with the engine's too-deep error, or answers the document where the server builds it", async () => {
    const expected = await Expected(inColumn);
    expect(await Answer(Iterated(Merged()))).to.deep.equal(expected);
  });

  /** Fails where the cursor's connection goes back to the pool still listing the warning. */
  it("leaves its connection answering a table-less read", async () => {
    for (let read = 0; read < 20; read += 1) {
      await Iterated(Merged()).catch(() => undefined);
      expect(Ones(await Read(TABLELESS))).to.deep.equal([1]);
    }
  });

  /**
   * Fails where `close` pools the connection once its result ended, though no `next` read the end
   * and listed the warning: a batch of one hands the row over in full, and the end arrives while
   * the caller waits.
   */
  it("leaves its connection answering a table-less read when closed after its last row", async () => {
    const restore = GetOptions();
    await Reconnect({ ...restore, cursorBatchSize: 1 });
    try {
      for (let read = 0; read < 5; read += 1) {
        const cursor = Merged()[Symbol.asyncIterator]();
        await cursor.next().catch(() => undefined);
        await delay(END_ARRIVES_MS);
        await cursor.return?.();
        expect(Ones(await Read(TABLELESS))).to.deep.equal([1]);
      }
    } finally {
      await Reconnect(restore);
    }
  });
});

describe("a cursor of batches of one over rows around a document deeper than the server builds", function () {
  this.timeout(30_000);

  InBatchesOfOne();

  let inColumn = 0;

  before(async () => {
    inColumn = await DeepestInColumn();
    await batchedDepth
      .instance()
      .table("rows")
      .insert([
        { _id: "a", tree: Nested(1) },
        { _id: "deepest", tree: Nested(inColumn) },
        { _id: "z", tree: Nested(1) },
      ])
      .run();
  });

  /**
   * MariaDB 11.8 answers SQL NULL with warning 4040 for the deepest row, so a cursor that lists the
   * warnings only at its end hands `null` over in that row's place before it fails.
   */
  it("hands over only rows it read whole before it fails with the engine's too-deep error", async () => {
    const merged = [
      { _id: "a", label: "merged", tree: Nested(1) },
      { _id: "deepest", label: "merged", tree: Nested(inColumn) },
      { _id: "z", label: "merged", tree: Nested(1) },
    ];
    const { rows, failure } = await HandedOver(
      batchedDepth
        .instance()
        .table("rows")
        .orderBy("_id")
        .map((row) => row.merge({ label: "merged" })),
    );
    expect(rows).to.deep.equal(merged.slice(0, rows.length));
    expect(Ending(failure, rows.length === merged.length)).to.equal(
      (await Nests(inColumn + 1)) ? "whole" : "too deep",
    );
  });
});
