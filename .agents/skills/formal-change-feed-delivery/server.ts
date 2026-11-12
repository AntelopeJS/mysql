/**
 * The fake server the real code talks to: sessions that implement `ConvergenceSession` over
 * `InnoDb`, the writers whose transactions the capture triggers log, and the `FeedEnvironment` a
 * feed reads through. Every statement is one step of the schedule, but a step no other session can
 * observe runs at once.
 */
import { Bind, type Sql } from "../../../src/statement";
import type { Row } from "../../../src/connection";
import { DIALECTS, type ChangeOperation } from "../../../src/dialect";
import type { ConvergenceSession } from "../../../src/implementations/database/locks";
import type { FeedEnvironment } from "../../../src/implementations/database/feeds";
import { ParseTable } from "../../../src/implementations/database/fields";
import { BuildTablePlan } from "../../../src/implementations/database/plan";
import type { TableOrigin } from "../../../src/implementations/database/relation";
import { ReadFrontier, Sequence } from "../../../src/implementations/database/sequencer";
import type { Footprint, Schedule, Step } from "./explore";
import { InnoDb, ModelError, POLLED, type Txn } from "./innodb";
import { Parse } from "./statements";
import { type Answer, type SessionState, TxnResources } from "./steps";

export const SCHEMA_ID = "shop";
export const TABLE_ID = "orders";
export const FEED_INSTANCE = "default";
export const OTHER_INSTANCE = "tenant";

const DEFINITION = { fields: {}, indexes: {} };

/** A table with no declared fields, as `src/test/unit/feeds-fixture.ts` builds it. */
const ORIGIN: TableOrigin = {
  schemaId: SCHEMA_ID,
  tableId: TABLE_ID,
  model: { fields: {} },
  plan: BuildTablePlan(SCHEMA_ID, TABLE_ID, DEFINITION, ParseTable(DEFINITION, `${SCHEMA_ID}.${TABLE_ID}`), {
    prefix: "",
    session: DIALECTS.mysql.session,
  }).plan,
  index: (name) => [name],
};

/** The physical table the feed watches, and another table of the same log. */
export const FEED_TABLE = ORIGIN.plan.table;
export const OTHER_TABLE = `${SCHEMA_ID}__invoices`;

/** What the feed's environment saw: when its open read the frontier, and the log at its last poll. */
export interface FeedProbe {
  wake: (() => void) | undefined;
  /** The writer commits counted when the open read its frontier. */
  openedAt: number | undefined;
  /** `InnoDb.version` when the last poll answered. */
  seen: number;
  /** `InnoDb.version` when the last wake was sent. */
  woken: number;
  /** How many wakes were sent, which names the next one. */
  wakes: number;
  done: boolean;
}

export class FakeServer {
  readonly db = new InnoDb();
  readonly schedule: Schedule;
  readonly modelErrors: string[] = [];
  /** Counts writer commits, the order the rules compare a feed's open against. */
  commits = 0;
  private nextSession = 1;

  constructor(schedule: Schedule) {
    this.schedule = schedule;
  }

  /** A connection of its own, as `OnDedicatedSession` or the pool hands one out. */
  session(actor: string): ConvergenceSession {
    const state: SessionState = { id: this.nextSession, txn: undefined };
    this.nextSession += 1;
    const run = (statement: Sql) => this.run(actor, state, statement);
    return {
      id: state.id,
      read: async (statement) => (await run(statement)).rows,
      apply: async (statement) => (await run(statement)).affected,
      write: async (statement) => (await run(statement)).affected,
    };
  }

  private run(actor: string, state: SessionState, statement: Sql): Promise<Answer> {
    const bound = Bind(statement);
    let op;
    try {
      op = Parse(bound, this.db, state);
    } catch (error) {
      if (error instanceof ModelError) {
        this.modelErrors.push(error.message);
      }
      return Promise.reject(error);
    }
    const execute = (): Answer => {
      const explicit = state.txn;
      const txn = explicit ?? this.db.begin();
      let result: Answer;
      try {
        result = op.run(txn);
      } catch (error) {
        if (error instanceof ModelError) {
          this.modelErrors.push(error.message);
        }
        if (!explicit) {
          this.db.rollback(txn);
        }
        this.schedule.trace.push(`${actor}: ${op.label} -> error ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      if (!explicit && state.txn === undefined) {
        this.db.commit(txn);
      }
      this.db.now += 1;
      if (op.label !== "read committed") {
        this.schedule.trace.push(`${actor}: ${op.label}${result.note}`);
      }
      return result;
    };
    if (op.local(state.txn)) {
      try {
        return Promise.resolve(execute());
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return this.schedule.submit(actor, op.label, () => !op.blocked(state.txn), () => op.footprint(state.txn), execute);
  }

  /** One write of a document in `txn`: its row lock, then the log row its capture trigger inserts. */
  write(actor: string, txn: Txn, target: WriteTarget): Promise<void> {
    const key = `doc:${target.tbl}:${target.inst}:${target.doc}`;
    return this.schedule.submit(
      actor,
      `${target.op} ${target.doc} (${target.label})`,
      () => !this.db.isHeldByOther(key, txn),
      (): Footprint => ({ reads: [], writes: [key, "ids"] }),
      () => {
        this.db.lock(key, txn);
        const id = this.db.insert(txn, target.tbl, target.inst, target.op, target.label);
        this.db.now += 1;
        this.schedule.trace.push(`${actor}: ${target.op} ${target.doc} as ${target.label} -> log id ${id}`);
      },
    );
  }

  /** The end of a writer's transaction. */
  finish(actor: string, txn: Txn, commit: boolean, onCommit: () => void): Promise<void> {
    const footprint = (): Footprint => ({ reads: [], writes: [...TxnResources(txn), "commits"] });
    return this.schedule.submit(actor, commit ? "commit" : "roll back", () => true, footprint, () => {
      if (commit) {
        this.commits += 1;
        onCommit();
        this.db.commit(txn);
      } else {
        this.db.rollback(txn);
      }
      this.db.now += 1;
      this.schedule.trace.push(`${actor}: ${commit ? `commit (writer commit ${this.commits})` : "roll back"}`);
    });
  }

  /** The feed's environment: the real open sequence and poll, on sessions of this server. */
  feedEnvironment(probe: FeedProbe): FeedEnvironment {
    const dialect = DIALECTS.mysql;
    return {
      dialect: () => dialect,
      origin: () => ORIGIN,
      install: () => Promise.resolve(),
      open: async () => {
        const session = this.session("feed open");
        await Sequence(session, dialect, "wait");
        const frontier = await ReadFrontier(session, dialect);
        probe.openedAt = this.commits;
        return frontier;
      },
      read: async (statement): Promise<Row[]> => {
        const rows = await this.session("feed poll").read(statement);
        probe.seen = this.db.version;
        return rows;
      },
      subscribe: (_table, wake) => {
        probe.wake = wake;
        return () => {
          probe.wake = undefined;
        };
      },
    };
  }

  /** The wake the change clock sends once the log moved past what the feed last read. */
  wakeStep(probe: FeedProbe): Step[] {
    const latest = this.db.version;
    const wake = probe.wake;
    const isWaiting = !this.schedule.waiting().some((step) => step.startsWith("feed"));
    if (probe.done || !wake || !isWaiting || latest <= Math.max(probe.seen, probe.woken)) {
      return [];
    }
    return [
      {
        id: `change clock#${probe.wakes}`,
        actor: "change clock",
        label: "wake the feed",
        enabled: () => true,
        footprint: () => ({ reads: POLLED, writes: ["feed"] }),
        run: () => {
          probe.woken = latest;
          probe.wakes += 1;
          this.schedule.trace.push("change clock: wake the feed");
          wake();
        },
      },
    ];
  }
}

/** One document write a writer makes. */
export interface WriteTarget {
  readonly tbl: string;
  readonly inst: string;
  readonly doc: string;
  readonly op: ChangeOperation;
  readonly label: string;
}
