import fc from "fast-check";

import {
  CUT_AGGREGATE,
  type DocRow,
  type Evaluation,
  LISTED_AT_MOST,
  type Out,
  type Payload,
  type Trace,
  TOO_DEEP,
} from "./engine";

/**
 * The scenarios the check draws and the rules it judges each run by. A scenario is a table, a few
 * operations on it through the real read paths, and writers that commit between the engine's
 * statements.
 */
export type Mutation =
  | { readonly kind: "set"; readonly index: number; readonly row: DocRow }
  | { readonly kind: "insert"; readonly row: DocRow }
  | { readonly kind: "remove"; readonly index: number };

export type Op =
  | { readonly kind: "read"; readonly payload: Payload; readonly isHeld: boolean }
  | { readonly kind: "cursor"; readonly payload: Payload; readonly batch: number; readonly calls: number }
  | { readonly kind: "write"; readonly payload: Payload; readonly isHeld: boolean };

export interface Scenario {
  readonly name: string;
  readonly rows: readonly DocRow[];
  readonly ops: readonly Op[];
  readonly writers: readonly Mutation[];
  readonly limit: number;
}

/** What one operation handed back to its caller. */
export interface Outcome {
  readonly delivered: readonly Out[];
  readonly error: Error | undefined;
  readonly isExhausted: boolean;
  readonly isHung: boolean;
  readonly affected: number | undefined;
  /** What went wrong asking the connections the operation used for a table-less read, if anything. */
  readonly next: string | undefined;
}

export interface Run {
  readonly scenario: Scenario;
  readonly positions: readonly number[];
  readonly outcomes: readonly Outcome[];
  readonly evaluations: readonly Evaluation[];
  readonly trace: readonly Trace[];
  readonly isTooDeep: (error: Error) => boolean;
}

function same(left: readonly Out[], right: readonly Out[]): boolean {
  return left.length === right.length && left.every((row, at) => isEqual(row, right[at]));
}

function isEqual(delivered: Out, reference: Out | undefined): boolean {
  return (
    reference !== undefined &&
    Object.entries(reference).every(([column, value]) => delivered[column] === value)
  );
}

function isPrefix(delivered: readonly Out[], reference: readonly Out[]): boolean {
  return delivered.length <= reference.length && delivered.every((row, at) => isEqual(row, reference[at]));
}

function evaluationsOf(run: Run, op: number): Evaluation[] {
  return run.evaluations.filter((evaluation) => evaluation.opIndex === op);
}

type Judge = (run: Run) => string[];

function perOp(run: Run, judge: (op: number, outcome: Outcome, evaluations: Evaluation[]) => string[]): string[] {
  return run.outcomes.flatMap((outcome, op) => judge(op, outcome, evaluationsOf(run, op)));
}

const READS: ReadonlySet<string> = new Set(["read", "cursor"]);

/** Whether a statement of the run raised more warnings than MariaDB lists at most, so a read cannot see them all. */
function isPastTheListing(run: Run): boolean {
  return run.evaluations.some((evaluation) => evaluation.raised > LISTED_AT_MOST);
}

function within(judge: Judge): Judge {
  return (run) => (isPastTheListing(run) ? [] : judge(run));
}

const PROMISES = {
  HandsOverTheReferenceRows: (run) =>
    perOp(run, (op, outcome, evaluations) => {
      const kind = run.scenario.ops[op]?.kind;
      if (!kind || !READS.has(kind) || outcome.isHung) {
        return [];
      }
      const whole = outcome.error === undefined && (kind === "read" || outcome.isExhausted);
      const fits = evaluations.some((evaluation) =>
        whole ? same(outcome.delivered, evaluation.reference) : isPrefix(outcome.delivered, evaluation.reference),
      );
      return fits
        ? []
        : [`op ${op} handed over ${JSON.stringify(outcome.delivered)}, which no run of its statement's reference rows is${whole ? "" : " a start of"}`];
    }),
  FailsOnlyOnALimit: (run) =>
    perOp(run, (op, outcome, evaluations) => {
      const { error } = outcome;
      if (!error || outcome.isHung) {
        return [];
      }
      const named = ofLimit(run, error);
      if (named === undefined) {
        return [`op ${op} failed with ${error.message}, which names no limit of the server`];
      }
      const hit = evaluations.some((evaluation) =>
        named === "deep" ? evaluation.isDeep : named === "cut" ? evaluation.isCut : evaluation.raised > LISTED_AT_MOST,
      );
      return hit ? [] : [`op ${op} failed on the ${named} limit, which no run of its statement reached`];
    }),
  NextStatementAnswers: (run) =>
    run.outcomes.flatMap((outcome, op) => (outcome.next === undefined ? [] : [`after op ${op}: ${outcome.next}`])),
  WriteStoresNoCutValue: (run) =>
    perOp(run, (op, outcome, evaluations) =>
      run.scenario.ops[op]?.kind === "write" && outcome.error === undefined && !outcome.isHung && evaluations.some((evaluation) => evaluation.storesCut)
        ? [`op ${op} answered ${outcome.affected} rows written and stored a cut or null value`]
        : [],
    ),
  Settles: (run) =>
    perOp(run, (op, outcome) => (outcome.isHung ? [`op ${op} never ended`] : [])),
} satisfies Record<string, Judge>;

/** The promises, each named for what it keeps, and the one that holds only where MariaDB lists every warning a statement raised. */
export const RULES = {
  HandsOverTheReferenceRows: within(PROMISES.HandsOverTheReferenceRows),
  FailsOnlyOnALimit: within(PROMISES.FailsOnlyOnALimit),
  NextStatementAnswers: within(PROMISES.NextStatementAnswers),
  WriteStoresNoCutValue: within(PROMISES.WriteStoresNoCutValue),
  Settles: within(PROMISES.Settles),
  NeverWrongPastTheListedWarnings: (run) =>
    isPastTheListing(run)
      ? [
          ...PROMISES.HandsOverTheReferenceRows(run),
          ...PROMISES.WriteStoresNoCutValue(run),
          ...PROMISES.NextStatementAnswers(run),
          ...PROMISES.Settles(run),
        ]
      : [],
} satisfies Record<string, Judge>;

/** `deep` for the engine's too-deep error, `cut` for the packet error, `unlisted` for the unlisted-warnings refusal. */
function ofLimit(run: Run, error: Error): "deep" | "cut" | "unlisted" | undefined {
  if (run.isTooDeep(error) || ("errno" in error && error.errno === TOO_DEEP)) {
    return "deep";
  }
  if (/max_allowed_packet/.test(error.message) || ("errno" in error && error.errno === CUT_AGGREGATE)) {
    return "cut";
  }
  return /max_error_count/.test(error.message) ? "unlisted" : undefined;
}

const containers = fc.constantFrom(0, 1, 28, 29, 30, 31, 32);
const bytes = fc.constantFrom(10, 100, 250, 333, 334, 499, 500, 501, 600, 998, 999, 1000, 1001);
const warns = fc.oneof(
  { weight: 24, arbitrary: fc.constant(0) },
  { weight: 8, arbitrary: fc.constantFrom(1, 2, 3) },
  { weight: 4, arbitrary: fc.constantFrom(63, 64, 65) },
  { weight: 1, arbitrary: fc.constantFrom(65_534, 65_535, 65_536, 70_000) },
);
const row: fc.Arbitrary<DocRow> = fc.record({ containers, bytes, warns });
const wrap = fc.constantFrom(0, 1, 2);
const readKind = fc.constantFrom("rows", "aggregate", "plain");

function mutation(size: number): fc.Arbitrary<Mutation> {
  return fc.oneof(
    fc.record({ kind: fc.constant("set" as const), index: fc.nat(size), row }),
    fc.record({ kind: fc.constant("insert" as const), row }),
    fc.record({ kind: fc.constant("remove" as const), index: fc.nat(size) }),
  );
}

function op(): fc.Arbitrary<Op> {
  const held = fc.boolean();
  return fc.oneof(
    fc.record({ kind: fc.constant("read" as const), payload: fc.record({ kind: readKind, wrap }), isHeld: held }),
    fc.record({
      kind: fc.constant("cursor" as const),
      payload: fc.record({ kind: readKind, wrap }),
      batch: fc.integer({ min: 1, max: 3 }),
      calls: fc.integer({ min: 1, max: 4 }),
    }),
    fc.record({
      kind: fc.constant("write" as const),
      payload: fc.record({ kind: fc.constantFrom("update", "stamp"), wrap }),
      isHeld: held,
    }),
  );
}

export interface Size {
  readonly rows: number;
  readonly ops: number;
  readonly writers: number;
}

export function scenarioArb(size: Size): fc.Arbitrary<Scenario> {
  return fc.record({
    name: fc.constant("drawn"),
    rows: fc.array(row, { maxLength: size.rows }),
    ops: fc.array(op(), { minLength: 1, maxLength: size.ops }),
    writers: fc.array(mutation(size.rows), { maxLength: size.writers }),
    limit: fc.integer({ min: 2, max: 3 }),
  });
}
