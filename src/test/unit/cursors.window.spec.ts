import { expect } from "chai";
import {
  CloseOneCursor,
  CountOpenCursors,
} from "../../implementations/database/cursors";
import {
  baseline,
  Count,
  Delay,
  DESCENDING_CURSORS,
  Drain,
  FORGOTTEN_HINT,
  GuardTheRegistry,
  NextReqId,
  OPEN,
  OverflowEndings,
  Read,
  REAP_WINDOW_MS,
  REAPING,
  Recorder,
  Rejection,
  Reopening,
  Requesting,
  Rows,
  STUB_FAILURE,
} from "./cursors-fixture";

describe("the cursor registry", () => {
  GuardTheRegistry();

  it("opens a run of descending ids after an eviction, refusing none of them", async () => {
    await OverflowEndings();
    for (let index = 0; index < DESCENDING_CURSORS; index += 1) {
      const log = Recorder();
      const rows = await Drain(NextReqId(), Requesting(log, [Rows(1, 2)]));
      expect(rows).to.deep.equal([1, 2]);
      expect(log.opens).to.equal(1);
      expect(Count(log, OPEN)).to.equal(1);
    }
  });

  it("refuses a reqId whose exhaustion it has forgotten, rather than re-opening it", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Reopening(log, 1, 2);
    expect(await Drain(reqId, open)).to.deep.equal([1, 2]);
    expect(await Read(reqId, open)).to.deep.equal([]);
    await OverflowEndings();
    const err = await Rejection(Read(reqId, open));
    expect(err.message).to.contain(`${reqId}`);
    expect(err.message).to.contain(FORGOTTEN_HINT);
    expect(log.opens).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("refuses a reqId whose reaping it has forgotten, rather than re-serving its rows", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Reopening(log, 1, 2, 3);
    expect(await Read(reqId, open, REAPING)).to.deep.equal([1, 2, 3]);
    await Delay(REAP_WINDOW_MS);
    expect(log.closes).to.equal(1);
    await OverflowEndings();
    const err = await Rejection(Read(reqId, open));
    expect(err.message).to.contain(`${reqId}`);
    expect(err.message).to.contain(FORGOTTEN_HINT);
    expect(log.opens).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("keeps serving a live cursor the forgotten range has grown around", async () => {
    const live = Recorder();
    const ended = Recorder();
    const liveId = NextReqId();
    const endedId = NextReqId();
    const openLive = Requesting(live, [Rows(1, 2, 3), Rows(4, 5, 6)]);
    expect(await Read(liveId, openLive)).to.deep.equal([1, 2, 3]);
    expect(CountOpenCursors()).to.equal(baseline + 1);
    expect(await Drain(endedId, Reopening(ended, 3, 4))).to.deep.equal([3, 4]);
    await OverflowEndings();
    expect(await Read(liveId, openLive)).to.deep.equal([4, 5, 6]);
    expect(CountOpenCursors()).to.equal(baseline + 1);
    expect(live.opens).to.equal(1);
    await CloseOneCursor(liveId);
    expect(live.closes).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("refuses a reqId whose failed open it has forgotten, rather than answering done", async () => {
    const log = Recorder();
    const reqId = NextReqId();
    const open = Requesting(log, [], OPEN);
    expect((await Rejection(Read(reqId, open))).message).to.equal(STUB_FAILURE);
    await OverflowEndings();
    const err = await Rejection(Read(reqId, open));
    expect(err.message).to.contain(`${reqId}`);
    expect(err.message).to.contain(FORGOTTEN_HINT);
    expect(log.opens).to.equal(1);
    expect(CountOpenCursors()).to.equal(baseline);
  });
});
