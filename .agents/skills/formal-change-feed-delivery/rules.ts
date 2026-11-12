/**
 * The scenarios the check draws and the rules it judges each run by. A scenario is the changes
 * that committed before it starts (`seeds`), then writers, sequencer ticks and reaper passes that
 * race one feed on the `shop.orders` table.
 */
import fc from "fast-check";
import type { ChangeOperation } from "../../../src/dialect";
import type { Reaped } from "./innodb";

/** Where a write lands: the feed's table and instance, another instance of it, or another table. */
export type Place = "feed" | "otherInstance" | "otherTable";

export interface WriteSpec {
  readonly place: Place;
  readonly doc: "a" | "b";
  readonly op: ChangeOperation;
}

export interface WriterSpec {
  readonly writes: readonly WriteSpec[];
  readonly commit: boolean;
}

export interface Scenario {
  /** Changes committed and not yet numbered when the scenario starts. */
  readonly seeds: readonly WriteSpec[];
  readonly writers: readonly WriterSpec[];
  /** Change-clock ticks, each a `Sequence` pass that skips while another pass holds the clock. */
  readonly ticks: number;
  /** Reaper passes, each in its own process. */
  readonly reapers: number;
  /** The reaper's `changeRetentionMs`, in ticks of the fake server's clock: one tick per step. */
  readonly retention: number;
  /** The feed's `changeBatchSize`. */
  readonly batch: number;
}

const writeArb: fc.Arbitrary<WriteSpec> = fc.record({
  place: fc.constantFrom<Place>("feed", "feed", "feed", "otherInstance", "otherTable"),
  doc: fc.constantFrom<"a" | "b">("a", "b"),
  op: fc.constantFrom<ChangeOperation>("added", "modified", "removed"),
});

/** The most seeded changes, writers, writes per writer, change-clock ticks and reaper passes a scenario draws. */
export interface Size {
  readonly seeds: number;
  readonly writers: number;
  readonly writes: number;
  readonly ticks: number;
  readonly reapers: number;
}

/** The scenarios of one size. */
export function scenarioArb(size: Size): fc.Arbitrary<Scenario> {
  return fc.record({
    seeds: fc.array(writeArb, { maxLength: size.seeds }),
    writers: fc.array(
      fc.record({
        writes: fc.array(writeArb, { minLength: 1, maxLength: size.writes }),
        commit: fc.constantFrom(true, true, true, false),
      }),
      { minLength: 1, maxLength: size.writers },
    ),
    ticks: fc.integer({ min: 0, max: size.ticks }),
    reapers: fc.integer({ min: 0, max: size.reapers }),
    retention: fc.constantFrom(0, 0, 30),
    batch: fc.integer({ min: 1, max: 3 }),
  });
}

/** A change a writer made, and what became of its transaction. */
export interface Change {
  readonly label: string;
  readonly place: Place;
  readonly doc: string;
  /** The writer commit that published it, counted from 1; absent when it rolled back. */
  commitIndex: number | undefined;
}

/** How the feed ended. */
export type Ending =
  | { readonly kind: "closed" }
  | { readonly kind: "lapsed"; readonly from: bigint; readonly to: bigint; readonly at: number }
  | { readonly kind: "failed"; readonly message: string };

/** What one run of a scenario under one order left. */
export interface Run {
  readonly changes: readonly Change[];
  /** Writer commits counted when the feed's first read began, and when its open read the frontier. */
  readonly openStartedAt: number;
  readonly openedAt: number | undefined;
  /** The `change` labels the feed delivered, in order. */
  readonly delivered: readonly string[];
  readonly ending: Ending;
  /** The `seq` each change was numbered with, if it was. */
  readonly seqs: ReadonlyMap<string, bigint>;
  /** Each pass that numbered rows, as the log ids it numbered in `seq` order. */
  readonly passes: readonly (readonly bigint[])[];
  /** The reaper's retention, in ticks. */
  readonly retention: number;
  /** Every row of the feed's table that a reaper deleted. */
  readonly reaped: readonly Reaped[];
  /** Whether every actor finished, and what stopped one that did not. */
  readonly settled: string | undefined;
  readonly trace: readonly string[];
}

type Judge = (run: Run) => string[];

function byLabel(run: Run): Map<string, Change> {
  return new Map(run.changes.map((change) => [change.label, change]));
}

function feedChanges(run: Run): Change[] {
  return run.changes.filter((change) => change.place === "feed" && change.commitIndex !== undefined);
}

/** Each rule answers the problems it finds in a run; none means it holds. */
export const RULES = {
  /** Every change committed on the feed's table and instance after the open is delivered, unless the feed reports the loss. */
  DeliversEveryChange: (run) => {
    if (run.openedAt === undefined || run.settled !== undefined) {
      return [];
    }
    const delivered = new Set(run.delivered);
    const { ending } = run;
    const isReported = (change: Change) => {
      const seq = run.seqs.get(change.label);
      return ending.kind === "lapsed" && seq !== undefined && seq >= ending.from;
    };
    return feedChanges(run)
      .filter((change) => (change.commitIndex ?? 0) > (run.openedAt ?? 0) && !delivered.has(change.label))
      .filter((change) => !isReported(change))
      .map(
        (change) =>
          `${change.label} committed after the open (writer commit ${change.commitIndex}, seq ${String(run.seqs.get(change.label))}) and was never delivered, and the feed ended ${ending.kind}`,
      );
  },
  /** No change is delivered twice. */
  DeliversOnce: (run) =>
    run.delivered
      .filter((label, index) => run.delivered.indexOf(label) !== index)
      .map((label) => `${label} was delivered twice`),
  /** The feed delivers only committed changes of its own table and instance. */
  DeliversOnlyItsCommittedChanges: (run) => {
    const changes = byLabel(run);
    return run.delivered.flatMap((label) => {
      const change = changes.get(label);
      if (!change || change.commitIndex === undefined) {
        return [`${label} was delivered but its transaction rolled back`];
      }
      return change.place === "feed" ? [] : [`${label} was delivered but was written to ${change.place}`];
    });
  },
  /** A change committed before the feed's first read began is not delivered. */
  SkipsChangesBeforeOpen: (run) => {
    const changes = byLabel(run);
    return run.delivered
      .filter((label) => (changes.get(label)?.commitIndex ?? Infinity) <= run.openStartedAt)
      .map((label) => `${label} committed before the feed opened (writer commit ${changes.get(label)?.commitIndex}) and was delivered`);
  },
  /** Two changes of one document are delivered in the order they committed. */
  KeepsRowOrder: (run) => {
    const changes = byLabel(run);
    const last = new Map<string, Change>();
    const problems: string[] = [];
    for (const label of run.delivered) {
      const change = changes.get(label);
      if (!change || change.commitIndex === undefined) {
        continue;
      }
      const before = last.get(change.doc);
      if (before?.commitIndex !== undefined && before.commitIndex > change.commitIndex) {
        problems.push(`${before.label} (writer commit ${before.commitIndex}) was delivered before ${label} (writer commit ${change.commitIndex}) of the same document`);
      }
      last.set(change.doc, change);
    }
    return problems;
  },
  /** A feed ends with a loss only when a reaper deleted a row of its table it had not read. */
  LapsesOnlyOnLoss: (run) => {
    const { ending } = run;
    if (ending.kind === "failed") {
      return [`the feed failed: ${ending.message}`];
    }
    if (ending.kind !== "lapsed") {
      return [];
    }
    const lost = run.reaped.some(({ seq }) => seq >= ending.from && seq <= ending.to);
    return lost ? [] : [`the feed ended as lapsed for seq ${ending.from} through ${ending.to}, but no row of its table in that range was reaped`];
  },
  /** A loss error names every row of its table, from where the feed stood, that was reaped before it ended. */
  NamesTheLostRange: (run) => {
    const { ending } = run;
    if (ending.kind !== "lapsed") {
      return [];
    }
    const before = run.reaped.filter(({ at }) => at < ending.at);
    const highest = before.reduce((top, { seq }) => (seq > top ? seq : top), 0n);
    const short = before
      .filter(({ seq }) => seq >= ending.from && seq > ending.to)
      .map(({ seq }) => `seq ${seq} of the feed's table was reaped before the feed ended, but its loss error names only ${ending.from} through ${ending.to}`);
    const wide = ending.to > highest ? [`the loss error names ${ending.from} through ${ending.to}, but the highest seq reaped from the feed's table was ${highest}`] : [];
    return [...short, ...wide];
  },
  /** A pass numbers the rows it takes in the order they were logged. */
  NumbersEachPassInLogOrder: (run) =>
    run.passes
      .filter((ids) => ids.some((id, n) => n > 0 && id < (ids[n - 1] ?? 0n)))
      .map((ids) => `one pass numbered log ids ${ids.join(", ")} in that seq order, not in the order they were logged`),
  /** The reaper deletes a row only once it has been numbered for longer than the retention. */
  KeepsRetention: (run) =>
    run.reaped
      .filter(({ at, sequencedAt }) => at - sequencedAt <= run.retention)
      .map(({ seq, at, sequencedAt }) => `seq ${seq} was numbered at tick ${sequencedAt} and reaped at tick ${at}, within the retention of ${run.retention}`),
  /** Every actor finishes: no statement waits forever and no pass fails. */
  Settles: (run) => (run.settled === undefined ? [] : [run.settled]),
} satisfies Readonly<Record<string, Judge>>;
