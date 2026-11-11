import { Logger } from "../../logger";
import { GetOptions } from "../../config";
import type { Dialect } from "../../dialect";
import { GetDialect, RegisterBeforeDisconnect } from "../../connection";
import { CHANGE_LOG } from "./registry";
import { type ConvergenceSession, OnDedicatedSession } from "./locks";
import { type Frontier, ReadFrontier, Sequence } from "./sequencer";

/** Releases one feed's wait, or remembers the wakeup for a feed that is not waiting. */
type Wake = () => void;

const TICK_FAILED =
  "the MySQL change clock could not read the change log; feeds of this process see writes late until it can";

const TICK_RECOVERED = "the MySQL change clock reads the change log again";

/** The feeds waiting on each physical table. */
const subscribers = new Map<string, Set<Wake>>();

let timer: NodeJS.Timeout | undefined;
let ticking: Promise<void> | undefined;
let isAgain = false;
let isFailing = false;

/** The frontier the last tick saw; the tick after it wakes the tables numbered past it. */
let seen: Frontier | undefined;

function WakeAll(): void {
  for (const wakes of subscribers.values()) {
    for (const wake of wakes) {
      wake();
    }
  }
}

function WakeTable(table: string): void {
  for (const wake of subscribers.get(table) ?? []) {
    wake();
  }
}

/**
 * Wakes the feeds of every table numbered since the last tick. A first tick, or one that finds the
 * log recreated, wakes every feed instead, since it cannot say what moved.
 */
async function Announce(
  session: ConvergenceSession,
  dialect: Dialect,
  frontier: Frontier,
): Promise<void> {
  const previous = seen;
  seen = frontier;
  if (!previous || previous.epoch !== frontier.epoch) {
    WakeAll();
    return;
  }
  if (frontier.frontier <= previous.frontier) {
    return;
  }
  const rows = await session.read(
    dialect.capture.changedTables(CHANGE_LOG, previous.frontier),
  );
  for (const row of rows) {
    WakeTable(String(row.get("tbl")));
  }
}

/** One look at the log: number what committed if anything waits, then wake whoever it concerns. */
async function Look(session: ConvergenceSession): Promise<void> {
  const dialect = GetDialect();
  let frontier = await ReadFrontier(session, dialect);
  if (frontier.pending) {
    await Sequence(session, dialect, "skip");
    frontier = await ReadFrontier(session, dialect);
  }
  await Announce(session, dialect, frontier);
}

function ReportRecovered(): void {
  if (isFailing) {
    isFailing = false;
    Logger.Info(TICK_RECOVERED);
  }
}

async function Looks(): Promise<void> {
  try {
    do {
      isAgain = false;
      await OnDedicatedSession(Look);
    } while (isAgain && subscribers.size > 0);
    ReportRecovered();
  } catch (err) {
    if (!isFailing) {
      isFailing = true;
      Logger.Warn(TICK_FAILED, err);
    }
  }
}

/**
 * One tick, never two at once. A nudge that lands while a tick runs makes it look again once it is
 * done, since its write may have committed after the look started.
 */
function Tick(): Promise<void> {
  if (ticking) {
    isAgain = true;
    return ticking;
  }
  const started = Looks().finally(() => {
    ticking = undefined;
  });
  ticking = started;
  return started;
}

function Start(): void {
  if (timer) {
    return;
  }
  seen = undefined;
  const started = setInterval(() => {
    void Tick();
  }, GetOptions().changePollIntervalMs);
  started.unref();
  timer = started;
}

/**
 * Stops the clock, forgets every subscriber, and settles once a tick still running has finished.
 * Registered to run before the pool ends, which is what lets that tick finish on an open pool.
 */
async function StopChangeLoop(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  subscribers.clear();
  seen = undefined;
  isAgain = false;
  await ticking;
}

/**
 * Wakes `wake` whenever rows of `table` are numbered, and answers the function that stops it.
 *
 * One clock per process, running only while a feed is subscribed. Each `changePollIntervalMs` it
 * reads where the log stands, numbers the rows that committed if any wait, and wakes the feeds of
 * the tables those rows belong to: a few statements per tick however many feeds are open, and the
 * bound on how late a write from another process is seen.
 */
export function SubscribeToChanges(table: string, wake: Wake): () => void {
  const wakes = subscribers.get(table) ?? new Set<Wake>();
  wakes.add(wake);
  subscribers.set(table, wakes);
  Start();
  return () => {
    const current = subscribers.get(table);
    current?.delete(wake);
    if (current?.size === 0) {
      subscribers.delete(table);
    }
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/**
 * Called after every write this process commits: ticks at once, so a feed of this process sees the
 * write without waiting for the interval. Nothing happens while no feed is subscribed.
 */
export function NudgeChanges(): void {
  if (subscribers.size > 0) {
    void Tick();
  }
}

RegisterBeforeDisconnect(StopChangeLoop);
