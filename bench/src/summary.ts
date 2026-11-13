import type { EngineId } from "./engine";
import type { BenchRecord, CaseRecord } from "./record";
import { Median, P95 } from "./stats";

/** One query on one engine, summed over every round. */
export interface CellSummary {
  readonly runs: number;
  readonly median: number;
  readonly p95: number;
  /** The lowest and highest of the rounds' own medians: how far the rounds agree. */
  readonly roundMedians: readonly [number, number];
  readonly correct: boolean;
  readonly error?: string;
  readonly answer: readonly string[];
  readonly serverMedian: number;
  readonly rowsExamined: number;
  readonly indexes: readonly string[];
}

export const POSTGRES: EngineId = "postgres-18";
export const FAMILY: readonly EngineId[] = [
  "mysql-8.4",
  "mysql-9.7",
  "mariadb-11.8",
  "mariadb-12.3",
];
export const ENGINES: readonly EngineId[] = [POSTGRES, ...FAMILY];

/** The summary of one query on one engine. */
export function Cell(
  record: BenchRecord,
  id: string,
  engine: EngineId,
): CellSummary {
  const rounds = record.rounds
    .filter((round) => round.engine === engine && !round.base)
    .flatMap((round) => round.cases.filter((timed) => timed.id === id));
  const timings = rounds.flatMap((timed) => timed.timings);
  const roundMedians = rounds.map((timed) => Median(timed.timings));
  const error = rounds.find((timed) => timed.error)?.error;
  const first = rounds[0];
  const answered =
    first !== undefined &&
    first.answer.length === first.expected.length &&
    first.answer.every((value, at) => value === first.expected[at]);
  const plan = record.engines
    .find((candidate) => candidate.id === engine)
    ?.plans.find((candidate) => candidate.id === id);
  return {
    runs: timings.length,
    median: Median(timings),
    p95: P95(timings),
    roundMedians: [Math.min(...roundMedians), Math.max(...roundMedians)],
    correct:
      error === undefined &&
      answered &&
      rounds.every((timed) => timed.wrongRuns === 0),
    error,
    answer: first?.answer ?? [],
    serverMedian: Median(plan?.serverMs ?? []),
    rowsExamined: Median(plan?.rowsExamined ?? []),
    indexes: [
      ...new Set(
        plan?.statements.flatMap((statement) => statement.indexes) ?? [],
      ),
    ],
  };
}

/** The cases that ask the same question of the same table: same kind, field and indexes. */
export function SameQuestion(
  record: BenchRecord,
  query: CaseRecord,
): CaseRecord[] {
  return record.cases.filter(
    (other) =>
      other.kind === query.kind &&
      other.field === query.field &&
      other.indexed === query.indexed,
  );
}

/** The fastest correct answer postgres gives to the question a case asks, by any form. */
export function BestPostgres(
  record: BenchRecord,
  query: CaseRecord,
): { id: string; median: number } | undefined {
  return SameQuestion(record, query)
    .map((other) => ({ id: other.id, cell: Cell(record, other.id, POSTGRES) }))
    .filter(({ cell }) => cell.correct)
    .map(({ id, cell }) => ({ id, median: cell.median }))
    .sort((left, right) => left.median - right.median)[0];
}

/** Why a row of the MySQL family needs a cause in the report, if it does. */
export interface Flags {
  readonly slower: boolean;
  readonly missesPostgresIndex: boolean;
  readonly missesDeclaredIndex: boolean;
  readonly wrong: boolean;
}

/** A cell of the MySQL family measured against postgres: its ratio to the best correct postgres answer, and why it is flagged. */
export interface Judgement {
  readonly ratio: number;
  readonly flags: Flags;
}

export function Judge(
  record: BenchRecord,
  query: CaseRecord,
  engine: EngineId,
): Judgement {
  const cell = Cell(record, query.id, engine);
  const best = BestPostgres(record, query);
  const postgres = Cell(record, query.id, POSTGRES);
  const ratio = best ? cell.median / best.median : Number.NaN;
  return {
    ratio,
    flags: {
      slower: ratio > 2,
      missesPostgresIndex:
        postgres.correct &&
        postgres.indexes.length > 0 &&
        cell.indexes.length === 0,
      missesDeclaredIndex:
        query.indexed && cell.correct && cell.indexes.length === 0,
      wrong: !cell.correct,
    },
  };
}
