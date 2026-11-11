import type { QueryStage } from "@antelopejs/interface-database/common";
import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";

import { Logger } from "../../logger";
import type { Sql } from "../../statement";
import type { Dialect } from "../../dialect";
import { GetOptions, IsExternal, type ResolvedOptions } from "../../config";
import {
  GetDialect,
  Read,
  RegisterBeforeDisconnect,
  type Row,
} from "../../connection";
import type { TablePlan } from "./plan";
import type { RowObject } from "./result";
import type { TableOrigin } from "./relation";
import { WaitForSchemaReady } from "./schema";
import { RegisteredOrigin } from "./selection";
import { EnsureTriggers } from "./change-log";
import { OnDedicatedSession } from "./locks";
import { SubscribeToChanges } from "./change-loop";
import { type Frontier, ReadFrontier, Sequence } from "./sequencer";
import { CompileFeed, type FeedPlan } from "./feed-pipeline";
import {
  type FeedTarget,
  type LoggedEvent,
  PollStatement,
  ReadPoll,
} from "./feed-poll";
import { DEFAULT_INSTANCE_ID, OptionsOf } from "./utils";
import { IsString } from "./guards";

/**
 * Why a feed stopped, and therefore what a read arriving after it is told.
 * `lapsed` and `restarted` are losses and raise, naming the feed and the range that went;
 * `closed` is an ending and resolves `done`.
 */
type FeedEnd =
  | { reason: "closed" }
  | { reason: "restarted"; target: FeedTarget }
  | { reason: "lapsed"; target: FeedTarget; gap: FeedGap };

const CLOSED: FeedEnd = { reason: "closed" };

const EMPTY = 0;

/**
 * How long a feed waits for a wake before it reads the log anyway. The change clock wakes it for
 * every row of its table, so this only bounds what a lost wake could cost.
 */
const FALLBACK_WAIT_MS = 5000;

const POLL_FAILED = "a MySQL change feed's poll failed and will be retried";

const EXTERNAL_FEED =
  'Change feeds are not available in mode "external": an external instance keeps no change log on the client\'s database';

/**
 * Everything a feed reaches outside itself, injected as one **named** object.
 *
 * Production supplies none of it. A spec supplies all of it, which is what lets the watermark, the
 * lag ending and the restart ending be stated without a server, and they have to be stated
 * somewhere, because **the conformance suite reaches none of them**. It rides on the state rather
 * than on module scope, so a spec's seam cannot outlive its own call.
 */
export interface FeedEnvironment {
  dialect: () => Dialect;
  origin: (schemaId: string, tableId: string) => TableOrigin;
  install: (plan: TablePlan) => Promise<void>;
  /** Numbers every row that committed, then answers where the log stands. */
  open: () => Promise<Frontier>;
  read: (statement: Sql) => Promise<Row[]>;
  subscribe: (table: string, wake: () => void) => () => void;
}

const LIVE: FeedEnvironment = {
  dialect: GetDialect,
  origin: RegisteredOrigin,
  install: EnsureTriggers,
  open: () =>
    OnDedicatedSession(async (session) => {
      const dialect = GetDialect();
      await Sequence(session, dialect, "wait");
      return ReadFrontier(session, dialect);
    }),
  read: (statement) => Read(statement),
  subscribe: SubscribeToChanges,
};

/** The range of `seq` a lapsed feed was promised and cannot be given, as the rejection names it. */
interface FeedGap {
  readonly from: bigint;
  readonly to: bigint;
}

interface FeedState {
  chain: Promise<unknown>;
  target?: FeedTarget;
  plan?: FeedPlan;
  watermark: bigint;
  epoch?: string;
  buffer: RowObject[];
  end?: FeedEnd;
  wake?: () => void;
  woken: boolean;
  full: boolean;
  ending: Promise<void>;
  endNow: () => void;
  unsubscribe?: () => void;
  env: FeedEnvironment;
}

/** A feed whose `Open` has run, which is the only state a poll is ever made from. */
interface OpenFeed extends FeedState {
  target: FeedTarget;
  plan: FeedPlan;
}

function IsOpen(state: FeedState): state is OpenFeed {
  return state.target !== undefined && state.plan !== undefined;
}

/**
 * How many ended feeds keep their entry before the oldest is dropped.
 * No forgotten-range guard beside it: a feed that re-opens costs an object, not a connection.
 */
const REMEMBERED_ENDINGS = 1024;

const feeds = new Map<number, FeedState>();
const retired: number[] = [];

let isSweeping = false;

function Ignore() {}

function Named(target: FeedTarget): string {
  return `${target.schemaId}.${target.tableId}`;
}

/** Names the range that went, which is the whole reason the reaper records a high-water at all. */
function LapsedMessage(target: FeedTarget, gap: FeedGap): string {
  return `change feed on '${Named(target)}' fell behind the retention window (changeRetentionMs): events ${gap.from} through ${gap.to} were reaped before it read them, so it cannot continue; re-open the feed`;
}

function RestartedMessage(target: FeedTarget): string {
  return `change feed on '${Named(target)}' cannot continue: the change log was recreated, so every event it had not read is gone; re-open the feed`;
}

function Registered(reqId: number, env?: FeedEnvironment): FeedState {
  const known = feeds.get(reqId);
  if (known) {
    return known;
  }
  let endNow = Ignore;
  const ending = new Promise<void>((resolve) => {
    endNow = resolve;
  });
  const state: FeedState = {
    chain: Promise.resolve(),
    watermark: 0n,
    buffer: [],
    woken: false,
    full: false,
    ending,
    endNow,
    env: env ?? LIVE,
  };
  feeds.set(reqId, state);
  return state;
}

export function IsRegisteredFeed(reqId: number): boolean {
  return feeds.has(reqId);
}

/** Records an ending and drops the oldest once the registry is over its bound. */
function Forget(reqId: number) {
  retired.push(reqId);
  while (retired.length > REMEMBERED_ENDINGS) {
    const dropped = retired.shift();
    if (dropped === undefined) {
      break;
    }
    feeds.delete(dropped);
  }
}

/** Ends the feed once, stops its wakes, and releases whatever read is waiting on it. */
function Retire(reqId: number, state: FeedState, end: FeedEnd) {
  if (!state.end) {
    state.end = end;
    Forget(reqId);
  }
  state.unsubscribe?.();
  state.unsubscribe = undefined;
  state.endNow();
  Wake(state);
}

/**
 * Releases a feed that is waiting, and remembers the wakeup for one that is not.
 * Without the flag a wake landing mid-poll is dropped and the next wait runs in full.
 */
function Wake(state: FeedState) {
  state.woken = true;
  const waiting = state.wake;
  state.wake = undefined;
  waiting?.();
}

/** Resolves on a wake for this feed, on the fallback wait, or on the feed ending. */
function Waited(state: FeedState): Promise<void> {
  if (state.woken) {
    state.woken = false;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      state.wake = undefined;
      resolve();
    }, FALLBACK_WAIT_MS);
    timer.unref();
    state.wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

/** Whether either side passed the feed's stages: a row entering or leaving them is delivered. */
function Admitted(event: LoggedEvent): boolean {
  return event.old?.matched === true || event.new?.matched === true;
}

/**
 * One logged event as the contract's `Changes<T>`.
 * The two sides follow the operation rather than the membership, and an absent side stays absent.
 */
function Delivered(event: LoggedEvent): RowObject {
  const change: RowObject = { changeType: event.op };
  if (event.op !== "added") {
    change.oldValue = event.old?.doc ?? null;
  }
  if (event.op !== "removed") {
    change.newValue = event.new?.doc ?? null;
  }
  return change;
}

/**
 * One poll: read what was numbered, check nothing was lost, and buffer what arrived.
 *
 * A batch that was not full moves the watermark to the frontier the same statement read, so a feed
 * whose table is quiet moves with the log. A full one moves it to the last row it scanned, admitted
 * or not, and the next poll reads on from there.
 */
async function Poll(
  reqId: number,
  state: OpenFeed,
  options: ResolvedOptions,
): Promise<void> {
  const { target, plan } = state;
  const limit = options.changeBatchSize;
  const statement = PollStatement(
    state.env.dialect(),
    plan,
    target,
    state.watermark,
    limit,
  );
  const answer = ReadPoll(await state.env.read(statement), plan.type);
  if (answer.epoch !== state.epoch) {
    Retire(reqId, state, { reason: "restarted", target });
    return;
  }
  const reaped = answer.highWater;
  if (reaped !== undefined && state.watermark < reaped) {
    const gap = { from: state.watermark + 1n, to: reaped };
    Retire(reqId, state, { reason: "lapsed", target, gap });
    return;
  }
  state.full = answer.scanned.length >= limit;
  for (const event of answer.scanned) {
    if (Admitted(event)) {
      state.buffer.push(Delivered(event));
    }
  }
  const last = answer.scanned.at(-1);
  if (state.full && last) {
    state.watermark = last.seq;
  } else if (answer.frontier > state.watermark) {
    state.watermark = answer.frontier;
  }
}

const ROOT_LENGTH = 3;

function RootId(stages: QueryStage[], index: number): string {
  const id: unknown = OptionsOf(stages[index])?.id;
  return IsString(id) ? id : "";
}

/** The stages between the `schema`/`instance`/`table` prefix and the trailing `changes`. */
function Between(stages: QueryStage[]): QueryStage[] {
  return stages.slice(ROOT_LENGTH, stages.length - 1);
}

/** The stored instance a feed reads, as its root's `instance` stage names it. */
function InstanceOf(stages: QueryStage[]): FeedTarget["instance"] {
  const id: unknown = OptionsOf(stages[1])?.id;
  if (id === CROSS_INSTANCE) {
    return CROSS_INSTANCE;
  }
  if (id === undefined || id === null) {
    return DEFAULT_INSTANCE_ID;
  }
  if (!IsString(id)) {
    throw new Error("An instance id must be a string or CROSS_INSTANCE");
  }
  return id;
}

/**
 * Opens the feed: install the table's triggers, number everything already committed, take the
 * frontier as the watermark, and subscribe to the change clock.
 *
 * A change committed before this point is not delivered. One whose transaction is still open is
 * numbered once it commits, so it is delivered: the at-least-once edge, in the right direction.
 * Numbering what committed is what an open waits on, so it takes longer the more rows no feed
 * and no reaper pass has numbered yet. A feed closed while it opened never subscribes: the clock
 * would otherwise tick for it until the pool ends.
 */
async function Open(state: FeedState, stages: QueryStage[]): Promise<void> {
  const schemaId = RootId(stages, 0);
  const tableId = RootId(stages, 2);
  const instance = InstanceOf(stages);
  await WaitForSchemaReady(schemaId);
  if (IsExternal()) {
    throw new Error(EXTERNAL_FEED);
  }
  const origin = state.env.origin(schemaId, tableId);
  const plan = CompileFeed(Between(stages), origin, state.env.dialect());
  await state.env.install(origin.plan);
  const opened = await state.env.open();
  const target: FeedTarget = {
    schemaId,
    tableId,
    table: origin.plan.table,
    instance,
  };
  state.target = target;
  state.plan = plan;
  state.epoch = opened.epoch;
  state.watermark = opened.frontier;
  if (!state.end) {
    state.unsubscribe = state.env.subscribe(target.table, () => Wake(state));
  }
}

function Ended(end: FeedEnd): IteratorResult<RowObject, void> {
  if (end.reason === "closed") {
    return { done: true, value: undefined };
  }
  throw new Error(
    end.reason === "lapsed"
      ? LapsedMessage(end.target, end.gap)
      : RestartedMessage(end.target),
  );
}

/**
 * Answers one event, waiting for as long as it takes, with a transient failure retried not fatal.
 * The poll is raced against the feed's own ending, since `pool.end()` abandons queued acquisitions.
 */
async function Advance(
  reqId: number,
  state: FeedState,
  stages: QueryStage[],
  options: ResolvedOptions,
): Promise<IteratorResult<RowObject, void>> {
  if (isSweeping) {
    Retire(reqId, state, CLOSED);
  }
  for (;;) {
    if (state.end) {
      return Ended(state.end);
    }
    const buffered = state.buffer.shift();
    if (buffered) {
      return { done: false, value: buffered };
    }
    if (!IsOpen(state)) {
      await Open(state, stages);
      continue;
    }
    state.woken = false;
    await Promise.race([
      Poll(reqId, state, options).catch((err: unknown) => {
        if (!state.end) {
          Logger.Warn(POLL_FAILED, err);
        }
      }),
      state.ending,
    ]);
    if (state.buffer.length === EMPTY && !state.end && !state.full) {
      await Waited(state);
    }
  }
}

/**
 * Answers one event of the feed named by `reqId`, opening it on the first read.
 *
 * Every read on one `reqId` is chained onto the last, the open included: two overlapping reads
 * would both poll from the same watermark, deliver the same events twice and advance it once. The
 * consumer's `next()` prevents neither.
 *
 * The options are read here, synchronously, so a spec can drive a feed through a temporary
 * configuration without the set outliving the call.
 */
export function ReadFeedEvent(
  reqId: number,
  stages: QueryStage[],
  env?: FeedEnvironment,
): Promise<IteratorResult<RowObject, void>> {
  const options = GetOptions();
  const state = Registered(reqId, env);
  const next = state.chain.then(() => Advance(reqId, state, stages, options));
  state.chain = next.then(Ignore, Ignore);
  return next;
}

/**
 * Closes the feed named by `reqId`, behind whatever read is still in flight on it.
 *
 * Total, as the contract requires, and deliberately **not** chained the way a cursor's close is: a
 * feed's pending read may be waiting indefinitely on a quiet table, so a close that queued behind
 * it would never run. Ending the state and waking the waiter is what lets that read resolve.
 */
export function CloseOneFeed(reqId: number): Promise<void> {
  Retire(reqId, Registered(reqId), CLOSED);
  return Promise.resolve();
}

/**
 * Ends every feed, and is registered to run before the pool is ended.
 *
 * A feed holds no connection between polls, so this exists so an abandoned feed's pending read
 * resolves `{done: true}` instead of being left suspended forever, and so a read starting during
 * the sweep ends rather than opening a connection the teardown will not wait for. Teardown is an
 * ending, not a loss, which is why it resolves rather than rejects.
 */
export async function CloseAllFeeds(): Promise<void> {
  isSweeping = true;
  try {
    for (const [reqId, state] of feeds.entries()) {
      Retire(reqId, state, CLOSED);
    }
    await Promise.resolve();
  } finally {
    isSweeping = false;
  }
}

RegisterBeforeDisconnect(CloseAllFeeds);
