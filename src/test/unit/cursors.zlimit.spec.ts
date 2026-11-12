import { expect } from "chai";
import type { Options } from "../../config";
import {
  CloseOneCursor,
  CountOpenCursors,
} from "../../implementations/database/cursors";
import {
  baseline,
  CAP_SETTING,
  claimed,
  CLOSE,
  Drain,
  GuardTheRegistry,
  NextReqId,
  OPTIONS,
  Read,
  Recorder,
  Rejection,
  Requesting,
  Rows,
  Settle,
  WhenHeld,
} from "./cursors-fixture";

/** Options that leave room for `places` more cursors than are open now. */
function Room(places: number): Options {
  return { ...OPTIONS, maxOpenCursors: CountOpenCursors() + places };
}

describe("the cursor registry's cap", () => {
  afterEach(async () => {
    await Promise.all(claimed.map((reqId) => CloseOneCursor(reqId)));
  });
  GuardTheRegistry();

  /**
   * A registry with no cap, or one that checks the cap after it has opened, takes the pooled
   * connection this refusal exists to leave free: the third cursor opens, which is what `opens`
   * would show.
   */
  it("refuses the cursor past maxOpenCursors, naming the setting, and opens nothing for it", async () => {
    const options = Room(2);
    const logs = [Recorder(), Recorder(), Recorder()];
    const ids = logs.map(() => NextReqId());
    await Read(ids[0], Requesting(logs[0], [Rows(1, 2, 3)]), options);
    await Read(ids[1], Requesting(logs[1], [Rows(1, 2, 3)]), options);
    const err = await Rejection(
      Read(ids[2], Requesting(logs[2], [Rows(1, 2, 3)]), options),
    );
    expect(err.message).to.contain(CAP_SETTING);
    expect(err.message).to.contain(`${options.maxOpenCursors}`);
    expect(logs.map((log) => log.opens)).to.deep.equal([1, 1, 0]);
    expect(CountOpenCursors()).to.equal(baseline + 2);
  });

  it("leaves the cursors under the cap serving their rows", async () => {
    const options = Room(1);
    const kept = Recorder();
    const keptId = NextReqId();
    const open = Requesting(kept, [Rows(1, 2, 3)]);
    expect((await Read(keptId, open, options)).value).to.equal(1);
    await Rejection(
      Read(NextReqId(), Requesting(Recorder(), [Rows(9)]), options),
    );
    expect((await Read(keptId, open, options)).value).to.equal(2);
  });

  /**
   * A registry that counted every state it remembers, rather than every state that holds a
   * connection, would refuse here: the first cursor ended but is still remembered.
   */
  it("admits a cursor again once one under the cap has ended", async () => {
    const options = Room(1);
    expect(
      await Drain(NextReqId(), Requesting(Recorder(), [Rows(1)])),
    ).to.deep.equal([1]);
    const log = Recorder();
    const reqId = NextReqId();
    expect(
      (await Read(reqId, Requesting(log, [Rows(2)]), options)).value,
    ).to.equal(2);
    expect(log.opens).to.equal(1);
  });

  it("admits a cursor again once a closed one has given its connection back", async () => {
    const options = Room(1);
    const first = NextReqId();
    await Read(first, Requesting(Recorder(), [Rows(1, 2, 3)]), options);
    await CloseOneCursor(first);
    const log = Recorder();
    const second = await Read(NextReqId(), Requesting(log, [Rows(5)]), options);
    expect(second.value).to.equal(5);
    expect(log.opens).to.equal(1);
  });

  /**
   * Two first reads that arrive in the same turn both see the count below the cap, so a check that
   * is separated from the claim by an await would let both open.
   */
  it("lets exactly one of two racing first reads take the last place", async () => {
    const options = Room(1);
    const logs = [Recorder(), Recorder()];
    const settled = await Promise.allSettled(
      logs.map((log) =>
        Read(NextReqId(), Requesting(log, [Rows(1, 2, 3)]), options),
      ),
    );
    expect(settled.map((outcome) => outcome.status)).to.deep.equal([
      "fulfilled",
      "rejected",
    ]);
    expect(logs.map((log) => log.opens)).to.deep.equal([1, 0]);
  });

  it("counts a cursor that is still opening against the cap", async () => {
    const options = Room(1);
    const opening = Recorder();
    opening.holdsOpen = true;
    const first = Read(NextReqId(), Requesting(opening, [Rows(1)]), options);
    await Settle();
    const refused = await Rejection(
      Read(NextReqId(), Requesting(Recorder(), [Rows(2)]), options),
    );
    expect(refused.message).to.contain(CAP_SETTING);
    opening.resumeOpen?.();
    expect((await first).value).to.equal(1);
  });

  it("counts a cursor whose close is still on the wire against the cap", async () => {
    const options = Room(1);
    const closing = Recorder();
    const reqId = NextReqId();
    await Read(reqId, Requesting(closing, [Rows(1, 2, 3)]), options);
    closing.holdsStatement = CLOSE;
    const ending = CloseOneCursor(reqId);
    const resume = await WhenHeld(closing);
    const refused = await Rejection(
      Read(NextReqId(), Requesting(Recorder(), [Rows(2)]), options),
    );
    expect(refused.message).to.contain(CAP_SETTING);
    resume();
    await ending;
    const log = Recorder();
    expect(
      (await Read(NextReqId(), Requesting(log, [Rows(3)]), options)).value,
    ).to.equal(3);
  });
});
