import { Logger } from "../../logger";
import { GetOptions } from "../../config";
import type { Dialect } from "../../dialect";
import { GetDialect, RegisterBeforeDisconnect } from "../../connection";
import { CHANGE_LOG } from "./registry";
import { type ConvergenceSession, OnDedicatedSession } from "./locks";
import { InSessionTransaction, Sequence, UnsignedOf } from "./sequencer";

/** How many passes a retention window gets, so the log holds at most about one and a half of them. */
const PASSES_PER_WINDOW = 2;

/** A retention short enough to divide below this is still worth one pass per timer tick. */
const SHORTEST_INTERVAL_MS = 1;

/** The most rows one reaping transaction deletes, so no delete holds its locks for long. */
const REAP_ROWS = 10_000;

const LOCK_PURPOSE = "reaper";

const REAP_FAILED =
  "the MySQL change log could not be reaped and will grow until it can be; every table that was ever watched logs a row per write";

const REAP_RECOVERED = "the MySQL change log is being reaped again";

let timer: NodeJS.Timeout | undefined;
let reaping: Promise<void> | undefined;
let isFailing = false;

/**
 * One batch, in one transaction: find the oldest numbered rows stamped longer ago than the
 * retention, raise each table's high-water to the highest `seq` among them, and delete them.
 * Answers how many rows went.
 */
function ReapBatch(
  session: ConvergenceSession,
  { capture }: Dialect,
  retentionMs: number,
): Promise<number> {
  return InSessionTransaction(session, async () => {
    const [row] = await session.read(
      capture.reapThrough(CHANGE_LOG, retentionMs, REAP_ROWS),
    );
    const found = row?.get("through");
    if (found === null || found === undefined) {
      return 0;
    }
    const through = UnsignedOf(row, "through");
    await session.write(capture.raiseReaped(CHANGE_LOG, through));
    return session.write(capture.reap(CHANGE_LOG, through));
  });
}

/** The reaper's lock name, scoped to the connected database, since named locks are server-wide. */
async function LockName(
  session: ConvergenceSession,
  dialect: Dialect,
): Promise<string> {
  const [row] = await session.read(dialect.catalog.readDatabase());
  return dialect.session.lockName(LOCK_PURPOSE, String(row?.get("name")));
}

/**
 * Numbers what committed, then deletes what is past its retention, under the reaper's named lock,
 * giving the lock back on every path that took it.
 *
 * Only numbered rows are reaped, and their age counts from when they were numbered, which is about
 * when they committed: a long transaction's rows are not reaped the moment it commits. Each table's
 * high-water is its own, so a feed on a table nobody writes is never ended as lapsed because
 * another table's rows went. A pass runs the sequencer first, so the log never fills with
 * unnumbered rows while no feed is open.
 *
 * A missing log is not a failure: a database no owned schema was ever registered on has none.
 * Answers whether the pass ran; another process holding the lock is the ordinary case on every
 * deployment of more than one.
 */
export async function ReapOnce(
  session: ConvergenceSession,
  dialect: Dialect,
  retentionMs: number,
): Promise<boolean> {
  const present = await session.read(dialect.catalog.readTable(CHANGE_LOG.log));
  if (present.length === 0) {
    return false;
  }
  const name = await LockName(session, dialect);
  const [lock] = await session.read(dialect.session.acquireLock(name, 0));
  if (Number(lock?.get("acquired")) !== 1) {
    return false;
  }
  try {
    await Sequence(session, dialect, "skip");
    let deleted = REAP_ROWS;
    while (deleted >= REAP_ROWS) {
      deleted = await ReapBatch(session, dialect, retentionMs);
    }
  } finally {
    await session.read(dialect.session.releaseLock(name));
  }
  return true;
}

/** Reports the end of a run of failures; only a pass that actually ran ends one. */
function ReportReaped(): void {
  if (isFailing) {
    isFailing = false;
    Logger.Info(REAP_RECOVERED);
  }
}

async function Reap(retentionMs: number): Promise<void> {
  try {
    const dialect = GetDialect();
    const reaped = await OnDedicatedSession((session) =>
      ReapOnce(session, dialect, retentionMs),
    );
    if (reaped) {
      ReportReaped();
    }
  } catch (err) {
    if (!isFailing) {
      isFailing = true;
      Logger.Error(REAP_FAILED, err);
    }
  }
}

/** One tick: never two at once, and never loud: a failing pass is reported once and tried again. */
function Tick(): void {
  if (reaping) {
    return;
  }
  reaping = Reap(GetOptions().changeRetentionMs).finally(() => {
    reaping = undefined;
  });
}

export function ReapInterval(retentionMs: number): number {
  return Math.max(
    SHORTEST_INTERVAL_MS,
    Math.floor(retentionMs / PASSES_PER_WINDOW),
  );
}

function StopTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

/**
 * Stops the reaper, and settles once a pass still running has finished. Registered below, so
 * `Disconnect` lets that pass end on an open pool rather than racing it.
 */
async function StopReaper(): Promise<void> {
  StopTimer();
  await reaping;
}

/**
 * Starts the reaper, and is idempotent so a reconnect does not leave two timers running.
 *
 * Owned by the connection rather than by a feed: a table watched once keeps its triggers, so the
 * log grows whether or not a feed is still open, and a process that never opens one still reaps,
 * since it may be the only one left connected. The timer is `unref`'d, so it never holds a process
 * open on its own.
 */
export function StartReaper(): void {
  StopTimer();
  isFailing = false;
  const started = setInterval(
    Tick,
    ReapInterval(GetOptions().changeRetentionMs),
  );
  started.unref();
  timer = started;
}

export function IsReaperRunning(): boolean {
  return timer !== undefined;
}

RegisterBeforeDisconnect(StopReaper);
