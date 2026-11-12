/**
 * The InnoDB state the change log lives in: the log, the clock and the reaped table, with READ
 * COMMITTED visibility and exclusive row locks. A transaction's changes stay pending on the rows it
 * changed until it commits; another transaction reads the committed version, and a locking read or
 * a write of a row another transaction holds waits or skips it. Only what the change log's
 * statements need is modelled: no gap or next-key locks, since every statement of the log under READ
 * COMMITTED takes record locks only.
 */
import type { ChangeOperation } from "../../../src/dialect";

/** A log row's columns that a statement changes after its insert. */
export interface Version {
  readonly seq: bigint | null;
  readonly sequencedAt: number | null;
}

/** One row of `__antelope_changes`, keyed by its `AUTO_INCREMENT` id. */
export interface LogRow {
  readonly id: bigint;
  readonly tbl: string;
  readonly inst: string;
  readonly op: ChangeOperation;
  /** The change it logs, which the images carry as the document's `change` field. */
  readonly label: string;
  committed: Version | undefined;
  pending: { readonly txn: Txn; readonly next: Version | "deleted" } | undefined;
}

/** A value with the transaction that changed it and has not committed yet. */
interface Pending<T> {
  committed: T | undefined;
  pending: { readonly txn: Txn; readonly next: T } | undefined;
}

export class Txn {
  readonly id: number;
  /** Set once a statement changed a row, so a commit has something to publish. */
  wrote = false;
  /** What its end publishes or releases, as footprint resources: tables, their locks, documents. */
  readonly resources = new Set<string>();
  readonly onCommit: (() => void)[] = [];

  constructor(id: number) {
    this.id = id;
  }
}

/** Raised for a statement or a state the model does not cover; the check then cannot run. */
export class ModelError extends Error {}

export interface ClockRow {
  readonly nextSeq: bigint;
  readonly epoch: string;
}

/** The log rows that carry a `seq`, which polls and the reaper read, as a footprint resource. */
export const NUMBERED = "log-numbered";

/** The log rows still without a `seq`, which the sequencer reads, as a footprint resource. */
export const UNNUMBERED = "log-unnumbered";

/** What a poll reads: a commit that changes none of it leaves every feed's next poll as it was. */
export const POLLED: readonly string[] = [NUMBERED, "clock", "reaped"];

/** The epoch the clock keeps throughout: no scenario recreates the log. */
export const EPOCH = "00000000-0000-4000-8000-00000000c10c";

export class InnoDb {
  readonly log = new Map<bigint, LogRow>();
  readonly clock: Pending<ClockRow> = {
    committed: { nextSeq: 1n, epoch: EPOCH },
    pending: undefined,
  };
  readonly reaped = new Map<string, Pending<bigint>>();
  readonly locks = new Map<string, Txn>();
  readonly named = new Map<string, number>();
  /** The `seq` each logged change was committed with, by label. */
  readonly numbered = new Map<string, bigint>();
  /** The `seq` of every row a committed `DELETE` removed, per table. */
  readonly deleted = new Map<string, bigint[]>();
  /** Counts commits that changed what a poll reads, so a feed can tell whether the log moved. */
  version = 0;
  /** The clock `UTC_TIMESTAMP(6)` reads: one tick per step. */
  now = 0;
  private nextId = 1n;
  private nextTxn = 1;

  begin(): Txn {
    const txn = new Txn(this.nextTxn);
    this.nextTxn += 1;
    return txn;
  }

  holder(key: string): Txn | undefined {
    return this.locks.get(key);
  }

  isHeldByOther(key: string, txn: Txn): boolean {
    const holder = this.locks.get(key);
    return holder !== undefined && holder !== txn;
  }

  lock(key: string, txn: Txn): void {
    if (this.isHeldByOther(key, txn)) {
      throw new ModelError(`lock ${key} taken while transaction ${String(this.locks.get(key)?.id)} holds it`);
    }
    this.locks.set(key, txn);
    txn.resources.add(ResourceOfLock(key));
  }

  holds(txn: Txn): boolean {
    return [...this.locks.values()].includes(txn);
  }

  /** What `txn` reads of a row: its own pending change, else the committed version. */
  visible(row: LogRow, txn: Txn): Version | undefined {
    if (row.pending?.txn === txn) {
      return row.pending.next === "deleted" ? undefined : row.pending.next;
    }
    return row.committed;
  }

  visibleOf<T>(value: Pending<T>, txn: Txn): T | undefined {
    return value.pending?.txn === txn ? value.pending.next : value.committed;
  }

  /** The log rows in primary-key order. */
  rows(): LogRow[] {
    return [...this.log.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** An insert into the log, as a capture trigger runs it inside the writer's transaction. */
  insert(txn: Txn, tbl: string, inst: string, op: ChangeOperation, label: string): bigint {
    const id = this.nextId;
    this.nextId += 1n;
    this.log.set(id, {
      id,
      tbl,
      inst,
      op,
      label,
      committed: undefined,
      pending: { txn, next: { seq: null, sequencedAt: null } },
    });
    txn.resources.add(UNNUMBERED);
    this.lock(`log:${id}`, txn);
    txn.wrote = true;
    return id;
  }

  /** Inserts a row that committed before the scenario starts, as an earlier writer left it. */
  seed(tbl: string, inst: string, op: ChangeOperation, label: string): void {
    const txn = this.begin();
    this.insert(txn, tbl, inst, op, label);
    this.commit(txn);
  }

  setPending(row: LogRow, txn: Txn, next: Version | "deleted"): void {
    if (row.pending !== undefined && row.pending.txn !== txn) {
      throw new ModelError(`log row ${row.id} changed while transaction ${row.pending.txn.id} changes it`);
    }
    this.lock(`log:${row.id}`, txn);
    row.pending = { txn, next };
    txn.resources.add(NUMBERED);
    if (row.committed?.seq === null) {
      txn.resources.add(UNNUMBERED);
    }
    txn.wrote = true;
  }

  commit(txn: Txn): void {
    for (const row of this.log.values()) {
      if (row.pending?.txn !== txn) {
        continue;
      }
      if (row.pending.next === "deleted") {
        this.log.delete(row.id);
        const seqs = this.deleted.get(row.tbl) ?? [];
        seqs.push(row.committed?.seq ?? -1n);
        this.deleted.set(row.tbl, seqs);
      } else {
        row.committed = row.pending.next;
        row.pending = undefined;
        if (row.committed.seq !== null) {
          this.numbered.set(row.label, row.committed.seq);
        }
      }
    }
    publish(this.clock, txn);
    for (const value of this.reaped.values()) {
      publish(value, txn);
    }
    this.release(txn);
    if (POLLED.some((resource) => txn.resources.has(resource))) {
      this.version += 1;
    }
    for (const effect of txn.onCommit) {
      effect();
    }
  }

  rollback(txn: Txn): void {
    for (const row of this.log.values()) {
      if (row.pending?.txn !== txn) {
        continue;
      }
      row.pending = undefined;
      if (row.committed === undefined) {
        this.log.delete(row.id);
      }
    }
    if (this.clock.pending?.txn === txn) {
      this.clock.pending = undefined;
    }
    for (const [tbl, value] of this.reaped) {
      if (value.pending?.txn === txn) {
        value.pending = undefined;
      }
      if (value.committed === undefined && value.pending === undefined) {
        this.reaped.delete(tbl);
      }
    }
    this.release(txn);
  }

  private release(txn: Txn): void {
    for (const [key, holder] of this.locks) {
      if (holder === txn) {
        this.locks.delete(key);
      }
    }
  }
}

/** The footprint resource a lock belongs to: a table's locks apart from its committed rows. */
function ResourceOfLock(key: string): string {
  if (key === "clock") {
    return "clock-lock";
  }
  if (key.startsWith("log:")) {
    return "log-locks";
  }
  if (key.startsWith("reaped:")) {
    return "reaped-lock";
  }
  return key;
}

function publish<T>(value: Pending<T>, txn: Txn): void {
  if (value.pending?.txn === txn) {
    value.committed = value.pending.next;
    value.pending = undefined;
  }
}
