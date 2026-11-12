import { expect } from "chai";

import type { Options } from "../../config";
import type { Row } from "../../connection";
import { type Sql, param, sql } from "../../statement";
import { WithOptions } from "./spec-fixture";
import {
  CloseOneCursor,
  CountOpenCursors,
  type CursorOpener,
  ReadCursorRow,
} from "../../implementations/database/cursors";
import type { RowSource } from "../../implementations/database/row-stream";

export const STATEMENT: Sql = sql`SELECT n FROM t WHERE n > ${param(7)}`;
export const BOUND_ARGS: readonly number[] = [7];

export const BATCH_SIZE = 3;
export const IDLE_TIMEOUT_MS = 30_000;
export const REAPED_AFTER_MS = 1;
export const REAP_WINDOW_MS = 40;
export const MAX_OPEN = 64;

/**
 * An idle timeout no other subsystem in this process would ask for.
 *
 * `CapturingTimers` records only the timers armed with exactly this delay, so a pool timer or
 * anything else the live adapter arms while a spec runs passes through uncounted (these specs share
 * their process with a constructed adapter).
 */
export const REAPER_PROBE_MS = 987_654;

export const OPEN = "OPEN";
export const CLOSE = "CLOSE";
export const NEXT = `NEXT ${BATCH_SIZE}`;
export const NEXT_PREFIX = "NEXT";

export const OPTIONS: Options = {
  cursorBatchSize: BATCH_SIZE,
  cursorIdleTimeoutMs: IDLE_TIMEOUT_MS,
  maxOpenCursors: MAX_OPEN,
};

export const REAPING: Options = {
  ...OPTIONS,
  cursorIdleTimeoutMs: REAPED_AFTER_MS,
};

export const PROBING: Options = {
  ...OPTIONS,
  cursorIdleTimeoutMs: REAPER_PROBE_MS,
};

export const STUB_FAILURE = "the stub source refused this call";
export const NEVER_ENDED = "the cursor never answered done";
export const NEVER_REJECTED = "the read was expected to reject";
export const NEVER_ARRIVED = "no read arrived while the sweep was running";
export const NEVER_HELD = "the stub never reached the call it was told to hold";
export const DOUBLE_CLOSE = "this source was already closed";
export const DRAIN_LIMIT = 50;

/** How many event-loop turns a spec gives a promise that must *not* settle before it concludes it will not. */
export const SETTLE_TURNS = 8;

/** A recorded moment that never happened; the specs assert the real value replaced it. */
export const NOT_OBSERVED = -1;

export const FORGOTTEN_HINT = "no longer remembered";
export const CAP_SETTING = "maxOpenCursors";
export const DESCENDING_CURSORS = 4;

export const STALE_TIMER = 0;
export const LAST_TIMER = 1;
export const NEXT_TURN_MS = 0;
export const IDLE_TIMEOUT_OPTION = "cursorIdleTimeoutMs";

/** The module forgets an ending once this many others have been recorded after it. */
export const REMEMBERED_ENDINGS = 1024;

/**
 * The interface's `nextReqId` is a process-global counter that starts at 0 and shares this process
 * with the specs, so the specs count down instead: the counter can never reach a negative id.
 * A file that allocates ids must sort after `cursors.spec`, whose first spec asserts it holds the
 * first one.
 */
export const FIRST_SPEC_REQ_ID = -1;

export interface Recording {
  statements: string[];
  opened: { statement: Sql; batchSize: number }[];
  opens: number;
  closes: number;
  whenClosed?: () => void;
  holdsNextPull?: boolean;
  resumePull?: () => void;
  holdsStatement?: string;
  resumeHeld?: () => void;
  holdsOpen?: boolean;
  resumeOpen?: () => void;
}

export function Recorder(): Recording {
  return { statements: [], opened: [], opens: 0, closes: 0 };
}

/**
 * A source that answers `next` from a queue of batches and records everything it is asked.
 *
 * `failing` names the call it refuses, which is how the pull failure path is driven without a
 * server. `close` writes into the same ordered log as the pulls, and counts itself only when it
 * returns, because the window between the state being marked ended and the connection being given
 * back is where every question about a connection still being held lives.
 *
 * `holdsStatement` parks one named call until the spec resolves it, which is the only way to observe
 * a teardown while it is running.
 */
export function StubSource(
  log: Recording,
  batches: Row[][],
  failing?: string,
): RowSource {
  let isClosed = false;
  return {
    next: (count: number) => {
      const statement = `${NEXT_PREFIX} ${count}`;
      log.statements.push(statement);
      if (statement === failing) {
        return Promise.reject(new Error(STUB_FAILURE));
      }
      const rows = batches.shift() ?? [];
      if (!log.holdsNextPull) {
        return Promise.resolve(rows);
      }
      log.holdsNextPull = false;
      return new Promise((resolve) => {
        log.resumePull = () => resolve(rows);
      });
    },
    close: () => {
      log.statements.push(CLOSE);
      const finish = () => {
        log.closes += 1;
        if (isClosed) {
          throw new Error(DOUBLE_CLOSE);
        }
        isClosed = true;
        log.whenClosed?.();
      };
      if (log.holdsStatement !== CLOSE) {
        finish();
        return Promise.resolve();
      }
      log.holdsStatement = undefined;
      return new Promise((resolve) => {
        log.resumeHeld = () => {
          finish();
          resolve();
        };
      });
    },
  };
}

export function Decode(rows: Row[]): number[] {
  return rows.map((row) => Number(row.get("n")));
}

/** An opener whose open records itself, optionally holds, and answers a stub over `batches`. */
export function Requesting(
  log: Recording,
  batches: Row[][],
  failing?: string,
): CursorOpener {
  return () =>
    Promise.resolve({
      statement: STATEMENT,
      decode: Decode,
      open: (statement, batchSize) => {
        log.opens += 1;
        log.opened.push({ statement, batchSize });
        log.statements.push(OPEN);
        if (failing === OPEN) {
          return Promise.reject(new Error(STUB_FAILURE));
        }
        if (log.holdsOpen) {
          log.holdsOpen = false;
          return new Promise((resolve) => {
            log.resumeOpen = () => resolve(StubSource(log, batches, failing));
          });
        }
        return Promise.resolve(StubSource(log, batches, failing));
      },
    });
}

export function Rows(...values: number[]): Row[] {
  return values.map((n) => new Map([["n", n]]));
}

/**
 * An opener whose every open answers the same rows from the top, which is what production does.
 *
 * `Requesting` hands one mutable batch queue to every source it makes, so a cursor that re-opened
 * would silently read an empty queue and look correct. Re-running the query from the top is what
 * makes a re-open visible as row 1 served a second time.
 */
export function Reopening(log: Recording, ...values: number[]): CursorOpener {
  return () =>
    Promise.resolve({
      statement: STATEMENT,
      decode: Decode,
      open: () => {
        log.opens += 1;
        return Promise.resolve(StubSource(log, [Rows(...values)]));
      },
    });
}

export let lastReqId = FIRST_SPEC_REQ_ID + 1;
export let claimed: number[] = [];

export function NextReqId(): number {
  lastReqId -= 1;
  claimed.push(lastReqId);
  return lastReqId;
}

/** One read, through a temporary configuration set and restored inside this one turn. */
export function Read(
  reqId: number,
  open: CursorOpener,
  options: Options = OPTIONS,
) {
  return WithOptions(options, () => ReadCursorRow(reqId, open));
}

export async function Drain(
  reqId: number,
  open: CursorOpener,
): Promise<unknown[]> {
  const values: unknown[] = [];
  while (values.length < DRAIN_LIMIT) {
    const next = await Read(reqId, open);
    if (next.done) {
      return values;
    }
    values.push(next.value);
  }
  throw new Error(NEVER_ENDED);
}

export async function Rejection(read: Promise<unknown>): Promise<Error> {
  try {
    await read;
  } catch (err) {
    if (err instanceof Error) {
      return err;
    }
    throw err;
  }
  throw new Error(NEVER_REJECTED);
}

export function Delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/** Gives every pending continuation room to run, so "has not settled" means it never will. */
export async function Settle(): Promise<void> {
  for (let turn = 0; turn < SETTLE_TURNS; turn += 1) {
    await Delay(NEXT_TURN_MS);
  }
}

/** Waits until the stub has parked `holdsStatement` on the wire, so the teardown is measurably mid-flight. */
export async function WhenHeld(log: Recording): Promise<() => void> {
  for (let turn = 0; turn < DRAIN_LIMIT; turn += 1) {
    if (log.resumeHeld) {
      return log.resumeHeld;
    }
    await Delay(NEXT_TURN_MS);
  }
  throw new Error(NEVER_HELD);
}

/** Fills the endings map past its bound, which forgets everything that ended before this call. */
export async function OverflowEndings(): Promise<void> {
  const filler = Recorder();
  for (let index = 0; index < REMEMBERED_ENDINGS; index += 1) {
    await Read(NextReqId(), Requesting(filler, [Rows()]));
  }
}

export interface TimerLog {
  armed: NodeJS.Timeout[];
  handlers: (() => void)[];
  cleared: NodeJS.Timeout[];
}

export function TimerRecorder(): TimerLog {
  return { armed: [], handlers: [], cleared: [] };
}

/**
 * Runs `body` with pass-through timer functions that collect the reaper's timers and handlers.
 *
 * Both wrappers forward to the real ones and return what they returned, so nothing observable
 * changes for anything else sharing the process, and only timers armed with `delayMs` are recorded:
 * the patch spans an `await`, and the live adapter this process also runs arms timers of its own.
 * Capturing the handler is what lets a spec fire a stale reaper on demand, which is the race the
 * timer's identity re-check exists for and which no wall-clock spec can schedule.
 */
export async function CapturingTimers(
  log: TimerLog,
  delayMs: number,
  body: () => Promise<void>,
): Promise<void> {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = Object.assign(
    <TArgs extends unknown[]>(
      handler: (...args: TArgs) => void,
      ms?: number,
      ...rest: TArgs
    ): NodeJS.Timeout => {
      const timer = realSet(handler, ms, ...rest);
      if (ms === delayMs) {
        log.armed.push(timer);
        log.handlers.push(() => handler(...rest));
      }
      return timer;
    },
    { __promisify__: realSet.__promisify__ },
  );
  globalThis.clearTimeout = (timer?: NodeJS.Timeout | string | number) => {
    const armed = log.armed.find((candidate) => candidate === timer);
    if (armed) {
      log.cleared.push(armed);
    }
    realClear(timer);
  };
  try {
    await body();
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
}

export function Count(log: Recording, statement: string): number {
  return log.statements.filter((entry) => entry === statement).length;
}

export let baseline = 0;

/** Registers the per-spec registry guard of the cursor suites. */
export function GuardTheRegistry(): void {
  beforeEach(() => {
    baseline = CountOpenCursors();
    claimed = [];
  });

  /**
   * A spec leaves nothing of its own checked out, and the sweep specs leave *less* than they found.
   *
   * `CloseAllCursors` is global, so a spec that drives it also reclaims whatever the live adapter
   * this process shares had open when the spec started. The check is therefore a ceiling on the
   * count rather than an equality with the baseline, which would read another subsystem's reclaimed
   * cursor as this file's leak.
   */
  afterEach(async () => {
    const held = CountOpenCursors();
    await Promise.all(claimed.map((reqId) => CloseOneCursor(reqId)));
    expect(held).to.be.at.most(baseline);
  });
}
