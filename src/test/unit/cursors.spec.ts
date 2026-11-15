import { expect } from "chai";
import {
  CloseOneCursor,
  CountOpenCursors,
} from "../../implementations/database/cursors";
import {
  baseline,
  CLOSE,
  Count,
  Delay,
  Drain,
  FIRST_SPEC_REQ_ID,
  FORGOTTEN_HINT,
  GuardTheRegistry,
  IDLE_TIMEOUT_OPTION,
  NEXT,
  NextReqId,
  OPEN,
  OverflowEndings,
  Read,
  REAP_WINDOW_MS,
  REAPED_AFTER_MS,
  REAPING,
  Recorder,
  Rejection,
  Reopening,
  Requesting,
  Rows,
} from "./cursors-fixture";

describe("the cursor registry", () => {
  GuardTheRegistry();

  /**
   * The top of the forgotten range is fixed by the first eviction the process ever makes.
   *
   * `Evicted` widens the range with `Math.max`, so the highest `reqId` it will ever carry is the
   * highest one it ever drops, and every id this file allocates is lower than the last. Only the
   * spec that owns the first two endings can therefore name the range's upper endpoint, which is
   * why this one runs first and asserts the id it was handed.
   *
   * The two endings are evicted highest-first, so the range's top is the id evicted earliest and
   * its bottom the id evicted last. A range that merely tracked the most recent eviction would
   * answer this exact pair with a top below its own bottom, and the highest id, refused here, would
   * re-open and serve its first row a second time.
   */
  it("refuses both ends of a forgotten range, its highest id evicted first", async () => {
    const upper = Recorder();
    const lower = Recorder();
    const upperId = NextReqId();
    const lowerId = NextReqId();
    expect(upperId).to.equal(FIRST_SPEC_REQ_ID);
    const openUpper = Reopening(upper, 1, 2);
    const openLower = Reopening(lower, 3, 4);
    expect(await Drain(upperId, openUpper)).to.deep.equal([1, 2]);
    expect(await Drain(lowerId, openLower)).to.deep.equal([3, 4]);
    await OverflowEndings();
    const refusedUpper = await Rejection(Read(upperId, openUpper));
    const refusedLower = await Rejection(Read(lowerId, openLower));
    expect(refusedUpper.message).to.contain(`${upperId}`);
    expect(refusedUpper.message).to.contain(FORGOTTEN_HINT);
    expect(refusedLower.message).to.contain(`${lowerId}`);
    expect(refusedLower.message).to.contain(FORGOTTEN_HINT);
    expect([upper.opens, lower.opens]).to.deep.equal([1, 1]);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  /**
   * A per-row driver answers `[0]` to the first read; one that fetches again after a short batch
   * makes a fourth `next` call; one that holds the source until the read after the short batch
   * keeps a connection out while the consumer works through its last rows.
   */
  it("hands over each fetched batch whole, closes the source with the short one, then answers `[]`", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(0, 1, 2), Rows(3, 4, 5), Rows(6)]);
    expect(await Read(reqId, open)).to.deep.equal([0, 1, 2]);
    expect(await Read(reqId, open)).to.deep.equal([3, 4, 5]);
    expect(log.closes).to.equal(0);
    expect(await Read(reqId, open)).to.deep.equal([6]);
    expect(log.closes).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
    expect(await Read(reqId, open)).to.deep.equal([]);
    expect(Count(log, NEXT)).to.equal(3);
    expect(log.statements).to.deep.equal([OPEN, NEXT, NEXT, NEXT, CLOSE]);
  });

  /**
   * A driver that arms the idle reaper after the short batch reclaims a cursor whose every row was
   * handed over, and its last read rejects in place of answering `[]`.
   */
  it("answers `[]` after a short batch however long the consumer took over it", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2)]);
    expect(await Read(reqId, open, REAPING)).to.deep.equal([1, 2]);
    await Delay(REAP_WINDOW_MS);
    expect(await Read(reqId, open, REAPING)).to.deep.equal([]);
    expect(log.closes).to.equal(1);
  });

  /**
   * A driver that records the ending with the short batch lets the endings of other cursors evict
   * it before the read after, which then rejects as forgotten in place of answering `[]`.
   */
  it("answers `[]` after a short batch however many cursors ended in between", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2)]);
    expect(await Read(reqId, open)).to.deep.equal([1, 2]);
    expect(log.closes).to.equal(1);
    await OverflowEndings();
    expect(await Read(reqId, open)).to.deep.equal([]);
    expect(log.opens).to.equal(1);
  });

  /** A driver that answers an empty selection with `[[]]` or leaves the source open fails this. */
  it("answers `[]` to the first read of an empty selection and releases the source", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows()]);
    expect(await Read(reqId, open)).to.deep.equal([]);
    expect(log.statements).to.deep.equal([OPEN, NEXT, CLOSE]);
    expect(log.closes).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("yields a full batch and then a short one, in order, and then ends", async () => {
    const log = Recorder();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4, 5)]);
    expect(await Drain(NextReqId(), open)).to.deep.equal([1, 2, 3, 4, 5]);
    expect(log.statements).to.deep.equal([OPEN, NEXT, NEXT, CLOSE]);
    expect(log.closes).to.equal(1);
  });

  it("ends after a short first batch without pulling a second time", async () => {
    const log = Recorder();
    const open = Requesting(log, [Rows(1, 2)]);
    expect(await Drain(NextReqId(), open)).to.deep.equal([1, 2]);
    expect(log.statements).to.deep.equal([OPEN, NEXT, CLOSE]);
  });

  it("pulls again after a batch that filled exactly, and ends on the empty one", async () => {
    const log = Recorder();
    const open = Requesting(log, [Rows(1, 2, 3), Rows()]);
    expect(await Drain(NextReqId(), open)).to.deep.equal([1, 2, 3]);
    expect(log.statements).to.deep.equal([OPEN, NEXT, NEXT, CLOSE]);
  });
});

describe("the cursor registry", () => {
  GuardTheRegistry();

  it("holds one registration while iterating and none once exhausted", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows()]);
    expect(await Read(reqId, open)).to.deep.equal([1, 2, 3]);
    expect(CountOpenCursors()).to.equal(baseline + 1);
    expect(await Read(reqId, open)).to.deep.equal([]);
    expect(CountOpenCursors()).to.equal(baseline);
    expect(log.closes).to.equal(1);
  });

  it("stays done after exhaustion, opening nothing", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1)]);
    expect(await Drain(reqId, open)).to.deep.equal([1]);
    expect(await Read(reqId, open)).to.deep.equal([]);
    expect(log.opens).to.equal(1);
    expect(log.closes).to.equal(1);
  });

  it("stays done after an explicit close, opening nothing", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4)]);
    expect(await Read(reqId, open)).to.deep.equal([1, 2, 3]);
    await CloseOneCursor(reqId);
    expect(await Read(reqId, open)).to.deep.equal([]);
    expect(log.opens).to.equal(1);
    expect(log.closes).to.equal(1);
    expect(Count(log, NEXT)).to.equal(1);
  });

  it("answers four concurrent reads over a two-row cursor on one source", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2)]);
    const answers = await Promise.all([
      Read(reqId, open),
      Read(reqId, open),
      Read(reqId, open),
      Read(reqId, open),
    ]);
    expect(answers).to.deep.equal([[1, 2], [], [], []]);
    expect(log.opens).to.equal(1);
    expect(log.closes).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("throws on a read after the idle reaper reclaimed the cursor", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4)]);
    expect(await Read(reqId, open, REAPING)).to.deep.equal([1, 2, 3]);
    await Delay(REAP_WINDOW_MS);
    await CloseOneCursor(reqId);
    const err = await Rejection(Read(reqId, open));
    expect(err.message).to.contain(IDLE_TIMEOUT_OPTION);
    expect(err.message).to.contain(`${REAPED_AFTER_MS} ms`);
    expect(err.message).to.contain(`${reqId}`);
    expect(log.opens).to.equal(1);
    expect(log.closes).to.equal(1);
  });

  it("closes exactly once when closed part-way through", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4)]);
    expect(await Read(reqId, open)).to.deep.equal([1, 2, 3]);
    await CloseOneCursor(reqId);
    expect(log.statements).to.deep.equal([OPEN, NEXT, CLOSE]);
    expect(log.closes).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });
});

describe("the cursor registry", () => {
  GuardTheRegistry();

  it("closes behind a read that is still in flight, and answers it first", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2, 3), Rows(4)]);
    const reading = Read(reqId, open);
    const closing = CloseOneCursor(reqId);
    const first = await reading;
    await closing;
    expect(first).to.deep.equal([1, 2, 3]);
    expect(log.statements).to.deep.equal([OPEN, NEXT, CLOSE]);
    expect(log.closes).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("does nothing on a second close, and nothing on a close after exhaustion", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [Rows(1, 2)]);
    await Drain(reqId, open);
    await CloseOneCursor(reqId);
    await CloseOneCursor(reqId);
    expect(Count(log, CLOSE)).to.equal(1);
    expect(log.closes).to.equal(1);
  });

  it("opens nothing on a close for a reqId that never opened", async () => {
    await CloseOneCursor(NextReqId());
    expect(CountOpenCursors()).to.equal(baseline);
  });

  /**
   * A close arriving before the first read ends the cursor rather than leaving it openable.
   *
   * `IterableCursor` calls `CloseCursor` unconditionally on `return()`, so a cursor that is
   * constructed and closed without ever being iterated reaches this module on a `reqId` it has
   * never seen. A close that registered nothing would leave that id looking new, and the next read
   * would take the open path: a connection taken, the statement run and row 0 served to a consumer
   * that has already closed the iterator.
   */
  it("answers done, opening nothing, after a close that preceded every read", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Reopening(log, 1, 2);
    await CloseOneCursor(reqId);
    expect(await Read(reqId, open)).to.deep.equal([]);
    expect(log.opens).to.equal(0);
    expect(log.statements).to.deep.equal([]);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  /**
   * The ending a close-before-open records is an ending like any other, and is forgotten like one.
   *
   * Registering a `reqId` without retiring it through the same path would leave one entry resident
   * for the life of the process per cursor closed unread, and the refusal below tells the two
   * apart: an entry that never joined the endings queue would still be there afterwards, answering
   * `done` where a genuinely forgotten `reqId` is refused.
   */
  it("forgets a close that preceded every read, like any other ending", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Reopening(log, 1, 2);
    await CloseOneCursor(reqId);
    await OverflowEndings();
    const err = await Rejection(Read(reqId, open));
    expect(err.message).to.contain(`${reqId}`);
    expect(err.message).to.contain(FORGOTTEN_HINT);
    expect(log.opens).to.equal(0);
    expect(CountOpenCursors()).to.equal(baseline);
  });
});
