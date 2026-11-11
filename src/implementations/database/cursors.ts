import type { Sql } from "../../statement";
import { GetOptions, type ResolvedOptions } from "../../config";
import { RegisterBeforeDisconnect, type Row } from "../../connection";
import type { RowValue } from "./result";
import { OpenRowStream, type RowSource } from "./row-stream";

/** Nothing left: an empty row buffer, or a registry holding no cursor the sweep still has work for. */
const EMPTY = 0;

/** The idle timeout of a cursor that never armed a reaper, which no reclaimed cursor can be. */
const UNARMED = 0;

/**
 * How many finished cursors keep the reason they finished before the oldest is forgotten.
 * Reaching the bound is ordinary, so {@link ForgottenRange} decides what a read past it is told.
 */
const REMEMBERED_ENDINGS = 1024;

/** Turns the driver's rows into what the caller asked for: `query.ts:DecodeRows`, bound to one relation. */
type RowDecoder = (rows: Row[]) => RowValue[];

/** Opens the stream a cursor reads; production never supplies one and takes {@link OpenRowStream}. */
type SourceOpener = (statement: Sql, batchSize: number) => Promise<RowSource>;

/**
 * Everything a cursor needs to open, as the caller that compiled it already holds it.
 *
 * The statement is rendered once and streamed once for the whole iteration, so every element comes
 * from one statement and one snapshot. `decode` is a row decoder and never a result decoder: see
 * `query.ts:DecodeRows`, which owns why the two differ.
 *
 * `open` is a seam for the specs, as `DecodingContext.resolveOrigin` is: this module's failures are
 * leaked pool connections rather than wrong answers, which no conformance assertion can see, so a
 * spec drives the buffering, the short-batch detection, the cap, the self-reclamation and the
 * teardown paths with no server.
 */
export interface CursorRequest {
  statement: Sql;
  decode: RowDecoder;
  open?: SourceOpener;
}

/** Compiles the cursor's statement, on the first read of a `reqId` and never again. */
export type CursorOpener = () => Promise<CursorRequest>;

/**
 * Why a cursor stopped, and therefore what a read arriving after it is told.
 * `exhausted`, `closed` and `failed` answer `done`; `reaped` and `forgotten` throw instead.
 */
type EndReason = "exhausted" | "closed" | "reaped" | "failed" | "forgotten";

const EXHAUSTED: EndReason = "exhausted";
const CLOSED: EndReason = "closed";
const REAPED: EndReason = "reaped";
const FAILED: EndReason = "failed";
const FORGOTTEN: EndReason = "forgotten";

interface OpenCursor {
  readonly source: RowSource;
  readonly decode: RowDecoder;
  readonly buffer: RowValue[];
  isDrained: boolean;
  timer?: NodeJS.Timeout;
}

interface CursorState {
  chain: Promise<unknown>;
  cursor?: OpenCursor;
  isOpening: boolean;
  idleTimeoutMs: number;
  reason?: EndReason;
}

/**
 * The lowest and highest `reqId` whose ending `REMEMBERED_ENDINGS` has actually dropped.
 * It spans the evicted ids at both ends, so an id inside it is refused rather than re-opened.
 */
interface ForgottenRange {
  readonly lowest: number;
  readonly highest: number;
}

type EndedAnswer = (
  reqId: number,
  state: CursorState,
) => IteratorResult<RowValue, void>;

const cursors = new Map<number, CursorState>();
const retired: number[] = [];

let forgotten: ForgottenRange | undefined;
let isSweeping = false;

function Ignore() {}

/** Runs a teardown step whose failure matters less than the connection it is giving back. */
function Quietly(step: () => void | Promise<void>): Promise<void> {
  return Promise.resolve().then(step).then(Ignore, Ignore);
}

function Done(): IteratorResult<RowValue, void> {
  return { done: true, value: undefined };
}

function Reclaimed(reqId: number, state: CursorState): never {
  throw new Error(
    `cursor ${reqId} was reclaimed after ${state.idleTimeoutMs} ms idle (cursorIdleTimeoutMs) and cannot be resumed; re-run the query`,
  );
}

function Forgotten(reqId: number): never {
  throw new Error(
    `cursor ${reqId} has already ended and how it ended is no longer remembered, more than ${REMEMBERED_ENDINGS} cursors having ended since; re-run the query`,
  );
}

const ENDED_ANSWERS: Record<EndReason, EndedAnswer> = {
  [EXHAUSTED]: Done,
  [CLOSED]: Done,
  [FAILED]: Done,
  [REAPED]: Reclaimed,
  [FORGOTTEN]: Forgotten,
};

function IsLive(state: CursorState): boolean {
  return state.reason === undefined;
}

/** True while a pooled connection is out on this state's behalf: being acquired, held, or being given back. */
function HoldsConnection(state: CursorState): boolean {
  return state.isOpening || state.cursor !== undefined;
}

/** A state the disconnect sweep still has work for: not yet ended, or ended and still holding on. */
function IsPending(state: CursorState): boolean {
  return IsLive(state) || HoldsConnection(state);
}

function PendingReqIds(): number[] {
  return [...cursors.entries()]
    .filter(([, state]) => IsPending(state))
    .map(([reqId]) => reqId);
}

/** Widens the range of `reqId`s whose ending has been dropped. */
function Evicted(reqId: number) {
  forgotten = forgotten
    ? {
        lowest: Math.min(forgotten.lowest, reqId),
        highest: Math.max(forgotten.highest, reqId),
      }
    : { lowest: reqId, highest: reqId };
}

/** A `reqId` the registry no longer holds because its ending was evicted, not because it is new. */
function WasForgotten(reqId: number): boolean {
  return (
    forgotten !== undefined &&
    reqId >= forgotten.lowest &&
    reqId <= forgotten.highest
  );
}

/** Records an ending and drops the oldest; only a state that holds nothing is ever queued. */
function Forget(reqId: number) {
  retired.push(reqId);
  while (retired.length > REMEMBERED_ENDINGS) {
    const dropped = retired.shift();
    if (dropped === undefined) {
      break;
    }
    cursors.delete(dropped);
    Evicted(dropped);
  }
}

/**
 * Ends the state once and for all, answering whether this call is the one that ended it.
 * Five paths reach {@link Teardown}, and only the caller that gets `true` may close the source.
 */
function Retire(reqId: number, state: CursorState, reason: EndReason): boolean {
  if (!IsLive(state)) {
    return false;
  }
  state.reason = reason;
  if (!HoldsConnection(state)) {
    Forget(reqId);
  }
  return true;
}

/** One state per `reqId` for its whole life, so no read can ever hold a state the registry replaced. */
function Registered(reqId: number): CursorState {
  const known = cursors.get(reqId);
  if (known) {
    return known;
  }
  const state: CursorState = {
    chain: Promise.resolve(),
    isOpening: false,
    idleTimeoutMs: UNARMED,
  };
  cursors.set(reqId, state);
  if (WasForgotten(reqId)) {
    Retire(reqId, state, FORGOTTEN);
  }
  return state;
}

/**
 * How many cursors hold a pooled connection, are acquiring one, or are giving one back.
 *
 * The question is "what is checked out", which is the only question this module's failures show up
 * in, so a cursor counts from the moment its open starts until its source has closed, including the
 * whole of a teardown, which is marked ended long before the connection is gone.
 */
export function CountOpenCursors(): number {
  return [...cursors.values()].filter(HoldsConnection).length;
}

/**
 * Refuses the open of one cursor past `maxOpenCursors`. Every cursor holds a connection until it
 * ends, so unchecked cursors would leave no connection for any other statement. Counting and
 * claiming happen in one synchronous step, so two opens racing for the last place cannot both win.
 */
function RefuseOverCap(options: ResolvedOptions) {
  const open = CountOpenCursors();
  if (open >= options.maxOpenCursors) {
    throw new Error(
      `cannot open another cursor: ${open} are open, which is the maxOpenCursors limit of ${options.maxOpenCursors}; read one to its end or close it, or raise maxOpenCursors (it defaults to half of pool.connectionLimit)`,
    );
  }
}

function ClearReaper(cursor: OpenCursor) {
  if (cursor.timer) {
    clearTimeout(cursor.timer);
    cursor.timer = undefined;
  }
}

/** Closes the source, which gives the connection back, and ends the state, whoever asked and however often. */
async function Teardown(
  reqId: number,
  state: CursorState,
  reason: EndReason,
): Promise<void> {
  const cursor = state.cursor;
  if (!Retire(reqId, state, reason) || !cursor) {
    return;
  }
  ClearReaper(cursor);
  await Quietly(() => cursor.source.close());
  state.cursor = undefined;
  Forget(reqId);
}

/** Reclaims the cursor only if the timer that fired is still its current one; a read may have re-armed it. */
async function Expire(
  reqId: number,
  state: CursorState,
  timer: NodeJS.Timeout,
): Promise<void> {
  if (state.cursor?.timer !== timer) {
    return;
  }
  await Teardown(reqId, state, REAPED);
}

/** Queues the reclaim behind whatever the entry is already doing, so it cannot cut into a read. */
function Reap(reqId: number, state: CursorState, timer: NodeJS.Timeout) {
  state.chain = state.chain
    .then(() => Expire(reqId, state, timer))
    .then(Ignore, Ignore);
}

/** Arms the idle reclaim; the timer is `unref`'d so it cannot hold the event loop open. */
function ArmReaper(
  reqId: number,
  state: CursorState,
  cursor: OpenCursor,
  idleTimeoutMs: number,
) {
  const timer = setTimeout(() => Reap(reqId, state, timer), idleTimeoutMs);
  timer.unref();
  cursor.timer = timer;
  state.idleTimeoutMs = idleTimeoutMs;
}

/** One batch; a batch shorter than the count asked for is the end of the cursor. */
async function FetchBatch(
  cursor: OpenCursor,
  batchSize: number,
): Promise<void> {
  const fetched = await cursor.source.next(batchSize);
  cursor.isDrained = fetched.length < batchSize;
  for (const value of cursor.decode(fetched)) {
    cursor.buffer.push(value);
  }
}

async function Refill(
  reqId: number,
  state: CursorState,
  cursor: OpenCursor,
  batchSize: number,
): Promise<void> {
  try {
    await FetchBatch(cursor, batchSize);
  } catch (err) {
    await Teardown(reqId, state, FAILED);
    throw err;
  }
}

/** Holds the opening flag across the whole open, so the sweep and the cap can see a connection on its way. */
async function Opened(
  state: CursorState,
  open: CursorOpener,
  options: ResolvedOptions,
): Promise<OpenCursor> {
  RefuseOverCap(options);
  state.isOpening = true;
  try {
    const request = await open();
    const source = await (request.open ?? OpenRowStream)(
      request.statement,
      options.cursorBatchSize,
    );
    return { source, decode: request.decode, buffer: [], isDrained: false };
  } finally {
    state.isOpening = false;
  }
}

async function Established(
  reqId: number,
  state: CursorState,
  open: CursorOpener,
  options: ResolvedOptions,
): Promise<OpenCursor> {
  if (state.cursor) {
    return state.cursor;
  }
  try {
    const cursor = await Opened(state, open, options);
    state.cursor = cursor;
    return cursor;
  } catch (err) {
    Retire(reqId, state, FAILED);
    throw err;
  }
}

async function Advance(
  reqId: number,
  state: CursorState,
  open: CursorOpener,
  options: ResolvedOptions,
): Promise<IteratorResult<RowValue, void>> {
  if (isSweeping) {
    await Teardown(reqId, state, CLOSED);
  }
  if (state.reason) {
    return ENDED_ANSWERS[state.reason](reqId, state);
  }
  const cursor = await Established(reqId, state, open, options);
  ClearReaper(cursor);
  if (cursor.buffer.length === EMPTY && !cursor.isDrained) {
    await Refill(reqId, state, cursor, options.cursorBatchSize);
  }
  if (cursor.buffer.length === EMPTY) {
    await Teardown(reqId, state, EXHAUSTED);
    return Done();
  }
  ArmReaper(reqId, state, cursor, options.cursorIdleTimeoutMs);
  return { done: false, value: cursor.buffer.shift() };
}

/**
 * Answers one element of the cursor named by `reqId`, opening it through `open` if it is unknown.
 *
 * Every read on one `reqId` is chained onto the last, the open included. Two overlapping reads
 * would both observe an empty buffer, both pull a batch and interleave the rows they shift, and two
 * overlapping first reads would open two streams and leak the connection of whichever lost the
 * registration. The consumer's `next()` prevents neither.
 *
 * Chaining orders those reads; it does not end them. A read can still arrive on a cursor that is
 * already gone: a fourth `next()` on a two-row cursor, a `next()` issued while `CloseCursor` is in
 * flight, a read racing the disconnect sweep, or one on a `reqId` whose ending is old enough to have
 * been forgotten. So a cursor that has stopped stays stopped and answers from how it stopped.
 * `EndReason` carries which answer and why, and the two that throw are the reclaimed cursor and the
 * forgotten one.
 *
 * A batch shorter than the configured count means the cursor is exhausted, so the last element is
 * answered without a further pull and the element after it tears the cursor down. Nothing asks for
 * that: the contract's own suite iterates to completion and never closes, so self-reclaim is the
 * only thing between this adapter and one leaked connection per iteration.
 *
 * The options are read here, synchronously, rather than inside the machinery, so that a spec can
 * drive a cursor through a temporary configuration without the set outliving the call.
 */
export function ReadCursorRow(
  reqId: number,
  open: CursorOpener,
): Promise<IteratorResult<RowValue, void>> {
  const options = GetOptions();
  const state = Registered(reqId);
  const next = state.chain.then(() => Advance(reqId, state, open, options));
  state.chain = next.then(Ignore, Ignore);
  return next;
}

/**
 * Closes the cursor named by `reqId`, behind whatever read is still in flight on it.
 *
 * Total, as the contract requires: it is called for a `reqId` that never opened, and twice for one
 * that did, and it neither throws nor rejects on either. The chaining is not tidiness: this is the
 * path `IterableCursor.return()` takes when a `for await` breaks in the middle of a `next()`, so the
 * read it has to wait for is usually still pending. Waiting on the chain is also what makes this the
 * sweep's one primitive: a teardown another path already started is itself on the chain, so a close
 * behind it resolves only once that teardown has finished.
 *
 * A close for a `reqId` that never opened registers it and ends it rather than doing nothing.
 * Nothing orders a close against a first read, and a `reqId` left unregistered still looks new to
 * the next read, which would open it and serve row 0 after the consumer closed the iterator. So it
 * is an ending that has to be remembered, exactly as a forgotten one is, and it costs one entry in
 * the endings map and no connection at all.
 */
export function CloseOneCursor(reqId: number): Promise<void> {
  const state = Registered(reqId);
  const closed = state.chain.then(() => Teardown(reqId, state, CLOSED));
  state.chain = closed.then(Ignore, Ignore);
  return closed;
}

/**
 * Closes every open cursor, and is registered to run before the pool is ended.
 *
 * `pool.end()` queues its quit behind whatever a connection is still running, so a cursor left open
 * hangs `destroy()` and the `Disconnect()` inside `Connect()` alike. The sweep acquires nothing:
 * every entry it walks already holds its connection, or is about to give it back.
 *
 * A snapshot of the registry is not enough on its own: a read arriving while the sweep runs would
 * register after the snapshot was taken and open a connection that nothing then closes. So the
 * sweep latches, every read that starts while it is latched ends its cursor instead of opening one,
 * and the loop runs until nothing is left pending.
 *
 * Pending, not live: a state marked ended may still be waiting on its source to close, and a sweep
 * that filtered on liveness would step over it and end the pool underneath a connection still held.
 */
export async function CloseAllCursors(): Promise<void> {
  isSweeping = true;
  try {
    let pending = PendingReqIds();
    while (pending.length > EMPTY) {
      await Promise.all(pending.map((reqId) => CloseOneCursor(reqId)));
      pending = PendingReqIds();
    }
  } finally {
    isSweeping = false;
  }
}

RegisterBeforeDisconnect(CloseAllCursors);
