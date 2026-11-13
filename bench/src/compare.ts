import type { EngineId } from "./engine";
import { Call, ENGINE_TITLES, Ms, Ratio } from "./format";
import type { QueryKind } from "./queries";
import type { BenchRecord, RoundRecord } from "./record";
import { Median } from "./stats";
import { FAMILY } from "./summary";

function Load(round: RoundRecord): number {
  return Number(round.loadAverage.split(" ")[0]);
}

/** The median of a case's timed runs over every run of one side on one engine. */
function SideMedian(
  record: BenchRecord,
  id: string,
  engine: EngineId,
  base: boolean,
): number {
  return Median(
    record.rounds
      .filter((round) => round.engine === engine && round.base === base)
      .flatMap((round) => round.cases.filter((timed) => timed.id === id))
      .flatMap((timed) => timed.timings),
  );
}

function Pair(record: BenchRecord, id: string, engine: EngineId): string {
  const base = SideMedian(record, id, engine, true);
  const head = SideMedian(record, id, engine, false);
  return `${Ms(base)} → ${Ms(head)} (${Ratio(head / base)})`;
}

/** The load average when each side's run started, round by round, on every engine. */
function LoadTable(record: BenchRecord): string[] {
  const rounds = [...new Set(record.rounds.map((round) => round.round))];
  const rows = rounds.flatMap((round) =>
    FAMILY.map((engine) => {
      const runs = record.rounds.filter(
        (one) => one.round === round && one.engine === engine,
      );
      const side = (base: boolean) =>
        runs
          .filter((one) => one.base === base)
          .map((one) => Load(one).toFixed(2))
          .join(", ") || "–";
      return `| ${round + 1} | ${ENGINE_TITLES[engine]} | ${side(true)} | ${side(false)} |`;
    }),
  );
  return [
    "| round | server | load, base run | load, head run |",
    "|---:|---|---:|---:|",
    ...rows,
  ];
}

/** The paired runs' report: a section of `RESULTS.md` and the file it links to, under `plans/`. */
export interface Comparison {
  readonly section: readonly string[];
  readonly file: readonly string[];
}

/** The file of every unindexed case's pair and each run's load, in `plans/`. */
export const COMPARISON_FILE = "base-head.md";

function PairTable(record: BenchRecord, kind?: QueryKind): string[] {
  const rows = record.cases
    .filter(
      (query) => !query.indexed && (kind === undefined || query.kind === kind),
    )
    .map(
      (query) =>
        `| \`${Call(query)}\` | ${FAMILY.map((engine) => Pair(record, query.id, engine)).join(" | ")} |`,
    );
  return [
    `| query | ${FAMILY.map((engine) => ENGINE_TITLES[engine]).join(" | ")} |`,
    `|---|${FAMILY.map(() => "---:").join("|")}|`,
    ...rows,
  ];
}

/**
 * Base and head measured back to back on the same servers, where the run had a base checkout:
 * median client ms of each side and their ratio, and the load each run started at. Nothing where
 * the run measured the code under test alone.
 */
export function Compared(record: BenchRecord): Comparison | undefined {
  const paired = record.rounds.filter((round) => FAMILY.includes(round.engine));
  if (!paired.some((round) => round.base)) {
    return undefined;
  }
  const loads = paired.map(Load);
  const base = record.baseRevision ?? "`BENCH_BASE`";
  const method = `Each round measured the base (${base}) and the code under test back to back on each MySQL-family server, against the same rows, which goes first alternating from round to round, so both sides share the machine's load. Median client ms of each side over its rounds, base → head (head ÷ base).`;
  return {
    section: [
      "### Base and head in the same window",
      "",
      `${method} The paired runs started at a load average of ${Math.min(...loads).toFixed(2)} to ${Math.max(...loads).toFixed(2)}. Unindexed filters:`,
      "",
      ...PairTable(record, "filter"),
      "",
      `Every unindexed case, and the load each run started at: [plans/${COMPARISON_FILE}](plans/${COMPARISON_FILE}).`,
      "",
    ],
    file: [
      "# Base and head in the same window",
      "",
      `${method} Back to [RESULTS.md](../RESULTS.md).`,
      "",
      ...PairTable(record),
      "",
      "The load average when each run started:",
      "",
      ...LoadTable(record),
      "",
    ],
  };
}
