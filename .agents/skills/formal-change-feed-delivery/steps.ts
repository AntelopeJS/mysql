/**
 * The steps the change log's statements become on `InnoDb`: what each one reads and changes, which
 * lock it waits on, and what it touches for the explorer. `statements.ts` maps the real SQL to them.
 */
import type { SqlValue } from "../../../src/statement";
import { IsString } from "../../../src/implementations/database/guards";
import type { Row } from "../../../src/connection";
import type { Footprint } from "./explore";
import { type InnoDb, type LogRow, ModelError, NUMBERED, POLLED, type Txn, UNNUMBERED, type Version } from "./innodb";

type Cell = string | number | null;

/** What a step answered: its rows, the rows it matched, a note for the trace, and the statement's next step if it has one. */
export interface Answer {
  readonly rows: Row[];
  readonly affected: number;
  readonly note: string;
  readonly more?: Op;
}

/** A statement bound to the model. */
export interface Op {
  readonly label: string;
  /** No other transaction can observe the step or be blocked by it, so it runs without a choice point. */
  local(txn: Txn | undefined): boolean;
  /** Whether the statement waits on a lock another transaction holds. */
  blocked(txn: Txn | undefined): boolean;
  /** The resources the statement reads and writes, a table standing for its rows and their locks. */
  footprint(txn: Txn | undefined): Footprint;
  run(txn: Txn): Answer;
}

/** The session state a statement reads: its open transaction, its connection id. */
export interface SessionState {
  readonly id: number;
  txn: Txn | undefined;
}

export function row(cells: Record<string, Cell>): Row {
  return new Map(Object.entries(cells));
}

function answer(rows: Row[], affected: number, note: string): Answer {
  return { rows, affected, note };
}

export function text(value: SqlValue | undefined, what: string): string {
  if (!IsString(value)) {
    throw new ModelError(`${what} is bound as ${String(value)}, not text`);
  }
  return value;
}

const NOTHING: Footprint = { reads: [], writes: [] };

function reads(...resources: string[]): () => Footprint {
  return () => ({ reads: resources, writes: [] });
}

function writes(...resources: string[]): () => Footprint {
  return () => ({ reads: [], writes: resources });
}

function heldByOther(db: InnoDb, key: string, txn: Txn | undefined): boolean {
  const holder = db.holder(key);
  return holder !== undefined && holder !== txn;
}

function ids(rows: readonly bigint[]): string {
  return rows.length === 0 ? "none" : rows.join(", ");
}

export function lockClock(db: InnoDb, mode: string | undefined): Op {
  const locking = mode !== undefined;
  const skip = mode === " FOR UPDATE SKIP LOCKED";
  return {
    label: `lock the clock${skip ? " (skip locked)" : locking ? " (wait)" : " (no lock)"}`,
    local: () => false,
    footprint: locking ? () => ({ reads: ["clock"], writes: ["clock-lock"] }) : reads("clock"),
    blocked: (txn) => locking && !skip && heldByOther(db, "clock", txn),
    run: (txn) => {
      if (locking && heldByOther(db, "clock", txn)) {
        return answer([], 0, " -> held elsewhere, skipped");
      }
      if (locking) {
        db.lock("clock", txn);
      }
      const clock = db.visibleOf(db.clock, txn);
      if (!clock) {
        return answer([], 0, " -> no clock row");
      }
      const cells = { next_seq: clock.nextSeq.toString(), epoch: clock.epoch };
      return answer([row(cells)], 0, ` -> next_seq ${clock.nextSeq}`);
    },
  };
}

/** How a scan of the log reads rows: in which order, how many at most, and whether it locks or skips them. */
interface Scan {
  readonly descending: boolean;
  readonly limit: number;
  readonly locking: boolean;
  readonly skip: boolean;
}

/**
 * The log row a scan visits after `after`, in its order, among the rows that exist now. A row that
 * committed with a `seq` is passed over without a step of its own: only a pass, which holds the
 * clock this scan holds, numbers a row, so visiting it answers the same at any moment.
 */
function nextRow(db: InnoDb, scan: Scan, after: bigint | undefined): LogRow | undefined {
  const rows = scan.descending ? db.rows().reverse() : db.rows();
  return rows.find(
    (each) =>
      (after === undefined || (scan.descending ? each.id < after : each.id > after)) &&
      (each.committed?.seq ?? null) === null,
  );
}

/**
 * One row of `unsequenced`'s scan. InnoDB reads a locking scan row by row, each against the latest
 * data and locks at that moment, so a transaction may commit, and another insert a row, between
 * two rows of one scan: each visit is a step of its own.
 */
function visit(db: InnoDb, scan: Scan, after: bigint | undefined, taken: number): Op {
  return {
    label: `select unnumbered rows${scan.skip ? " skip locked" : scan.locking ? " for update" : ""}, after id ${String(after ?? "start")}`,
    local: () => false,
    footprint: scan.locking ? () => ({ reads: [UNNUMBERED, "ids"], writes: ["log-locks"] }) : reads(UNNUMBERED, "ids"),
    blocked: (txn) => {
      const next = nextRow(db, scan, after);
      return scan.locking && !scan.skip && next !== undefined && heldByOther(db, `log:${next.id}`, txn);
    },
    run: (txn) => {
      const next = taken < scan.limit ? nextRow(db, scan, after) : undefined;
      if (!next) {
        return answer([], 0, " -> end of scan");
      }
      const more = visit(db, scan, next.id, taken);
      const version = db.visible(next, txn);
      if (scan.locking && heldByOther(db, `log:${next.id}`, txn)) {
        return { ...answer([], 0, ` -> id ${next.id} locked, skipped`), more };
      }
      if (version === undefined || version.seq !== null) {
        return { ...answer([], 0, ` -> id ${next.id} not waiting`), more };
      }
      if (scan.locking) {
        db.lock(`log:${next.id}`, txn);
      }
      return { ...answer([row({ id: next.id.toString() })], 0, ` -> id ${next.id} taken`), more: visit(db, scan, next.id, taken + 1) };
    },
  };
}

/**
 * A plain `unsequenced`. At READ COMMITTED, InnoDB reads it as a consistent read: one read view,
 * taken as the statement starts reading, judges every row it visits, so the whole read is one step.
 */
function snapshot(db: InnoDb, scan: Scan): Op {
  return {
    label: `select unnumbered rows as of one moment${scan.descending ? ", newest first" : ""}`,
    local: () => false,
    footprint: reads(UNNUMBERED, "ids"),
    blocked: () => false,
    run: (txn) => {
      const rows = scan.descending ? db.rows().reverse() : db.rows();
      const taken = rows.filter((each) => db.visible(each, txn)?.seq === null).slice(0, scan.limit);
      return answer(
        taken.map((each) => row({ id: each.id.toString() })),
        0,
        ` -> ids ${ids(taken.map((each) => each.id))}`,
      );
    },
  };
}

/** `unsequenced`: the rows still without a `seq`, in log order, read as InnoDB reads them. */
export function unsequenced(db: InnoDb, descending: boolean, limit: number, mode: string | undefined): Op {
  const locking = mode !== undefined;
  const scan = { descending, limit, locking, skip: mode === " FOR UPDATE SKIP LOCKED" };
  return locking ? visit(db, scan, undefined, 0) : snapshot(db, scan);
}

export function stamp(db: InnoDb, list: readonly string[], first: bigint): Op {
  const targets = list.map((id) => BigInt(id));
  const range = targets.map((_, n) => first + BigInt(n));
  const others = () => [...db.log.values()].filter((each) => !targets.includes(each.id));
  const pendingSeq = (each: LogRow) => (each.pending && each.pending.next !== "deleted" ? each.pending.next.seq : null);
  return {
    label: `number ids ${ids(targets)} from seq ${first}`,
    footprint: () => ({ reads: ["clock-lock"], writes: [NUMBERED, UNNUMBERED, "log-locks"] }),
    local: (txn) =>
      txn !== undefined &&
      db.holder("clock") === txn &&
      targets.every((id) => db.holder(`log:${id}`) === txn) &&
      others().every((each) => !range.includes(each.committed?.seq ?? -1n) && !range.includes(pendingSeq(each) ?? -1n)),
    blocked: (txn) =>
      targets.some((id) => heldByOther(db, `log:${id}`, txn)) ||
      others().some((each) => each.pending?.txn !== txn && range.includes(pendingSeq(each) ?? -1n)),
    run: (txn) => {
      let matched = 0;
      targets.forEach((id, n) => {
        const target = db.log.get(id);
        if (!target || !db.visible(target, txn)) {
          return;
        }
        const seq = first + BigInt(n);
        if (others().some((each) => each.committed?.seq === seq || pendingSeq(each) === seq)) {
          throw Object.assign(new Error(`Duplicate entry '${seq}' for key '__antelope_changes.seq'`), { errno: 1062 });
        }
        db.setPending(target, txn, { seq, sequencedAt: db.now });
        matched += 1;
      });
      return answer([], matched, ` -> ${matched} rows`);
    },
  };
}

export function advance(db: InnoDb, count: bigint): Op {
  return {
    label: `move the clock by ${count}`,
    footprint: writes("clock", "clock-lock"),
    local: (txn) => txn !== undefined && db.holder("clock") === txn,
    blocked: (txn) => heldByOther(db, "clock", txn),
    run: (txn) => {
      const clock = db.visibleOf(db.clock, txn);
      if (!clock) {
        return answer([], 0, " -> no clock row");
      }
      db.lock("clock", txn);
      db.clock.pending = { txn, next: { ...clock, nextSeq: clock.nextSeq + count } };
      txn.resources.add("clock");
      txn.wrote = true;
      return answer([], 1, ` -> next_seq ${clock.nextSeq + count}`);
    },
  };
}

export function frontier(db: InnoDb): Op {
  return {
    label: "read the frontier",
    local: () => false,
    footprint: reads("clock", UNNUMBERED, "commits"),
    blocked: () => false,
    run: (txn) => {
      const clock = db.visibleOf(db.clock, txn);
      if (!clock) {
        return answer([], 0, " -> no clock row");
      }
      const pending = db.rows().some((each) => db.visible(each, txn)?.seq === null);
      const cells = { epoch: clock.epoch, frontier: (clock.nextSeq - 1n).toString(), pending: pending ? 1 : 0 };
      return answer([row(cells)], 0, ` -> frontier ${clock.nextSeq - 1n}${pending ? ", rows waiting" : ""}`);
    },
  };
}

export function reapThrough(db: InnoDb, micros: number, limit: number): Op {
  return {
    label: "find what is past retention",
    local: () => false,
    footprint: reads(NUMBERED),
    blocked: () => false,
    run: (txn) => {
      const old = db
        .rows()
        .map((each) => db.visible(each, txn))
        .filter((version): version is Version => version?.sequencedAt != null && version.sequencedAt < db.now - micros / 1000)
        .sort((a, b) => (a.sequencedAt ?? 0) - (b.sequencedAt ?? 0))
        .slice(0, limit);
      const through = old.reduce<bigint | null>((max, each) => (each.seq !== null && (max === null || each.seq > max) ? each.seq : max), null);
      return answer([row({ through: through === null ? null : through.toString() })], 0, ` -> through ${String(through)}`);
    },
  };
}

export function raiseReaped(db: InnoDb, through: bigint): Op {
  const highs = (txn: Txn | undefined) => {
    const found = new Map<string, bigint>();
    for (const each of db.rows()) {
      const seq = txn ? db.visible(each, txn)?.seq : each.committed?.seq;
      if (seq !== null && seq !== undefined && seq <= through) {
        found.set(each.tbl, seq > (found.get(each.tbl) ?? 0n) ? seq : (found.get(each.tbl) ?? 0n));
      }
    }
    return found;
  };
  return {
    label: `raise the high-water through ${through}`,
    local: () => false,
    footprint: () => ({ reads: [NUMBERED], writes: ["reaped-lock"] }),
    blocked: (txn) => [...highs(txn).keys()].some((tbl) => heldByOther(db, `reaped:${tbl}`, txn)),
    run: (txn) => {
      const found = highs(txn);
      for (const [tbl, high] of found) {
        const value = db.reaped.get(tbl) ?? { committed: undefined, pending: undefined };
        db.reaped.set(tbl, value);
        const current = db.visibleOf(value, txn);
        db.lock(`reaped:${tbl}`, txn);
        value.pending = { txn, next: current !== undefined && current > high ? current : high };
        txn.resources.add("reaped");
        txn.wrote = true;
      }
      return answer([], found.size, ` -> ${[...found].map(([tbl, high]) => `${tbl} ${high}`).join(", ") || "nothing"}`);
    },
  };
}

export function reap(db: InnoDb, through: bigint): Op {
  const inRange = (version: Version | "deleted" | undefined) =>
    version !== undefined && version !== "deleted" && version.seq !== null && version.seq <= through;
  return {
    label: `delete through seq ${through}`,
    footprint: () => ({ reads: [NUMBERED], writes: ["log-locks"] }),
    local: () => false,
    blocked: (txn) =>
      db
        .rows()
        .some((each) => heldByOther(db, `log:${each.id}`, txn) && (inRange(each.committed) || inRange(each.pending?.next))),
    run: (txn) => {
      const gone: bigint[] = [];
      for (const each of db.rows()) {
        const version = db.visible(each, txn);
        if (!heldByOther(db, `log:${each.id}`, txn) && version?.seq != null && inRange(version)) {
          db.setPending(each, txn, "deleted");
          gone.push(version.seq);
        }
      }
      return answer([], gone.length, ` -> deleted seq ${ids(gone)}`);
    },
  };
}

/** The JSON of one polled side: the logged document, which every scenario's feed admits. */
function side(label: string): string {
  return JSON.stringify({ doc: { change: label }, matched: true });
}

export function poll(db: InnoDb, args: readonly SqlValue[], scoped: boolean, limit: number): Op {
  const tail = args.slice(scoped ? -3 : -2);
  const table = text(tail[0], "the polled table");
  const instance = scoped ? text(tail[1], "the polled instance") : undefined;
  const after = BigInt(text(tail.at(-1), "the polled seq"));
  const reapedTable = text(args[0], "the high-water table");
  return {
    label: `poll ${table} after seq ${after}`,
    local: () => false,
    footprint: () => ({ reads: POLLED, writes: ["feed"] }),
    blocked: () => false,
    run: (txn) => {
      const clock = db.visibleOf(db.clock, txn);
      if (!clock) {
        return answer([], 0, " -> no clock row");
      }
      const top = clock.nextSeq - 1n;
      const reaped = db.reaped.get(reapedTable);
      const high = reaped ? db.visibleOf(reaped, txn) : undefined;
      const header = { epoch: clock.epoch, frontier: top.toString(), high_water: high === undefined ? null : high.toString() };
      const events = db
        .rows()
        .flatMap((each) => {
          const seq = db.visible(each, txn)?.seq;
          const isMine = each.tbl === table && (instance === undefined || each.inst === instance);
          return isMine && seq != null && seq > after && seq <= top ? [{ each, seq }] : [];
        })
        .sort((a, b) => (a.seq < b.seq ? -1 : 1))
        .slice(0, limit);
      const rows = events.map(({ each, seq }) =>
        row({
          ...header,
          seq: seq.toString(),
          op: each.op,
          old_side: each.op === "added" ? null : side(each.label),
          new_side: each.op === "removed" ? null : side(each.label),
        }),
      );
      const empty = row({ ...header, seq: null, op: null, old_side: null, new_side: null });
      const note = ` -> frontier ${top}, high-water ${String(high)}, seq ${ids(events.map((event) => event.seq))}`;
      return answer(rows.length === 0 ? [empty] : rows, 0, note);
    },
  };
}

export function constant(label: string, rows: Row[]): Op {
  return { label, local: () => true, blocked: () => false, footprint: () => NOTHING, run: () => answer(rows, 0, "") };
}

export function getLock(db: InnoDb, session: SessionState, name: string): Op {
  return {
    label: "take the reaper's named lock",
    local: () => false,
    footprint: writes(`named:${name}`),
    blocked: () => false,
    run: () => {
      const owner = db.named.get(name);
      const acquired = owner === undefined || owner === session.id;
      if (acquired) {
        db.named.set(name, session.id);
      }
      return answer([row({ acquired: acquired ? 1 : 0 })], 0, acquired ? " -> taken" : " -> held elsewhere");
    },
  };
}

export function releaseLock(db: InnoDb, session: SessionState, name: string): Op {
  return {
    label: "give the reaper's named lock back",
    local: () => false,
    footprint: writes(`named:${name}`),
    blocked: () => false,
    run: () => {
      const owned = db.named.get(name) === session.id;
      if (owned) {
        db.named.delete(name);
      }
      return answer([row({ released: owned ? 1 : 0 })], 0, "");
    },
  };
}

/** What a transaction's end publishes and releases. */
export function TxnResources(txn: Txn | undefined): string[] {
  return txn ? [...txn.resources] : [];
}

export function ending(db: InnoDb, session: SessionState, commit: boolean): Op {
  return {
    label: commit ? "commit" : "roll back",
    local: (txn) => txn === undefined || (!txn.wrote && !db.holds(txn)),
    footprint: (txn) => ({ reads: [], writes: TxnResources(txn) }),
    blocked: () => false,
    run: (txn) => {
      if (commit) {
        db.commit(txn);
      } else {
        db.rollback(txn);
      }
      session.txn = undefined;
      return answer([], 0, "");
    },
  };
}

export function control(label: string, effect: () => void): Op {
  return {
    label,
    local: () => true,
    footprint: () => NOTHING,
    blocked: () => false,
    run: () => {
      effect();
      return answer([], 0, "");
    },
  };
}
