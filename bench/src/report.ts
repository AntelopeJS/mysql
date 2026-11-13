import { execFileSync } from "node:child_process";
import {
  existsSync,
  statSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { EngineId } from "./engine";
import { COMPARISON_FILE, Compared } from "./compare";
import { Call, ENGINE_TITLES, Ms, Ratio } from "./format";
import { KINDS, type QueryKind } from "./queries";
import type { BenchRecord, CaseRecord } from "./record";
import {
  BestPostgres,
  Cell,
  ENGINES,
  FAMILY,
  Judge,
  POSTGRES,
  type CellSummary,
} from "./summary";

const PLANS_FOLDER = "plans";
const FINDINGS = "findings.md";
const RESULTS = "RESULTS.md";
const PLAN_PART_BYTES = 17_000;
const SIZE_CEILING_BYTES = 20_000;
const SQL_WIDTH = 1500;

const KIND_TITLES: Record<QueryKind, string> = {
  filter: "Filter on equality",
  orderBy: "orderBy, then slice(0, 20)",
  lookup: "Lookup from a 20-review page of the reviews table",
};

const RATIO_TITLES = FAMILY.map((engine) => `${ENGINE_TITLES[engine]} ÷ pg`);

/** The interface call a case makes, as a consumer writes it. */
function Timing(cell: CellSummary): string {
  if (cell.error !== undefined) {
    return "error";
  }
  return `${Ms(cell.median)} (${Ms(cell.p95)})${cell.correct ? "" : " ✗"}`;
}

function Used(cell: CellSummary): string {
  return cell.indexes.length > 0 ? "yes" : "no";
}

/** Each reason a server of the family is flagged, with the servers it holds for unless it holds for all. */
function FlagText(record: BenchRecord, query: CaseRecord): string {
  const reasons = new Map<string, string[]>();
  const flag = (reason: string, engine: EngineId) =>
    reasons.set(reason, [
      ...(reasons.get(reason) ?? []),
      ENGINE_TITLES[engine],
    ]);
  for (const engine of FAMILY) {
    const { flags } = Judge(record, query, engine);
    if (flags.wrong) flag("wrong answer", engine);
    if (flags.slower) flag("> 2× pg", engine);
    if (flags.missesPostgresIndex) flag("misses pg's index", engine);
    if (flags.missesDeclaredIndex) flag("declared index unused", engine);
  }
  const text = [...reasons].map(([reason, titles]) =>
    titles.length === FAMILY.length
      ? reason
      : `${reason} (${titles.join(", ")})`,
  );
  if (!Cell(record, query.id, POSTGRES).correct) text.push("pg answers wrong");
  return text.join(", ");
}

function KindTable(record: BenchRecord, kind: QueryKind): string[] {
  const rows = record.cases
    .filter((query) => query.kind === kind)
    .map((query) => {
      const cells = ENGINES.map((engine) => Cell(record, query.id, engine));
      const best = BestPostgres(record, query);
      return [
        `\`${Call(query)}\``,
        query.indexed ? "declared" : "none",
        ...cells.map(Timing),
        ...FAMILY.map((engine) => Ratio(Judge(record, query, engine).ratio)),
        best
          ? (record.cases.find((other) => other.id === best.id)?.form ?? "–")
          : "–",
        cells.map(Used).join(" / "),
        FlagText(record, query),
      ];
    });
  return [
    `| query | indexes | ${ENGINES.map((engine) => ENGINE_TITLES[engine]).join(" | ")} | ${RATIO_TITLES.join(" | ")} | pg baseline | index used ${ENGINES.map((engine) => ENGINE_TITLES[engine]).join(" / ")} | flags |`,
    `|---|---|${ENGINES.map(() => "---:").join("|")}|${RATIO_TITLES.map(() => "---:").join("|")}|---|---|---|`,
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
  ];
}

function ServerTable(record: BenchRecord, kind: QueryKind): string[] {
  const rows = record.cases
    .filter((query) => query.kind === kind)
    .map((query) => {
      const cells = ENGINES.map((engine) => Cell(record, query.id, engine));
      return [
        `\`${query.id}\``,
        ...cells.map((cell) => `${Ms(cell.serverMedian)} / ${Ms(cell.median)}`),
        ...cells.map((cell) => String(Math.round(cell.rowsExamined))),
        ...cells.map(
          (cell) =>
            `${Ms(cell.roundMedians[0])}–${Ms(cell.roundMedians[1])} (n=${cell.runs})`,
        ),
      ];
    });
  const titles = ENGINES.map((engine) => ENGINE_TITLES[engine]);
  return [
    `| case | ${titles.map((title) => `${title} server / client ms`).join(" | ")} | ${titles.map((title) => `${title} rows read`).join(" | ")} | ${titles.map((title) => `${title} round medians`).join(" | ")} |`,
    `|---|${ENGINES.map(() => "---:").join("|")}|${ENGINES.map(() => "---:").join("|")}|${ENGINES.map(() => "---:").join("|")}|`,
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
  ];
}

/** `name (image)` entries counted by image, as `mysql:8.4 ×3`. */
function ByImage(containers: ReadonlySet<string>): string {
  const counts = new Map<string, number>();
  for (const container of containers) {
    const image = /\(([^)]*)\)$/.exec(container)?.[1] ?? container;
    counts.set(image, (counts.get(image) ?? 0) + 1);
  }
  return counts.size === 0
    ? "none"
    : [...counts].map(([image, count]) => `${image} ×${count}`).join(", ");
}

function Environment(record: BenchRecord): string[] {
  const { machine, settings } = record;
  const minutes =
    (Date.parse(record.finishedAt) - Date.parse(record.startedAt)) / 60_000;
  const loads = record.rounds.map((round) =>
    Number(round.loadAverage.split(" ")[0]),
  );
  const others = new Set(
    record.rounds.flatMap((round) =>
      round.containers.filter((name) => !name.includes("bench-")),
    ),
  );
  return [
    `- Machine: ${machine.cpu}, ${machine.cores} cores, ${machine.memoryGb} GB, ${machine.kernel}; Node ${machine.node}; Docker ${machine.docker}.`,
    ...record.engines.map(
      (engine) =>
        `- ${engine.version}: \`${engine.digest}\`. Seeding took ${Object.values(
          engine.seed.fillMs,
        )
          .map((ms) => `${(ms / 1000).toFixed(1)} s`)
          .join(" + ")} through the module.`,
    ),
    `- Run: ${record.startedAt} to ${record.finishedAt}, ${minutes.toFixed(0)} minutes. ${settings.rows} rows per table; ${settings.rounds} rounds; per round and query 2 warm-up runs, then up to ${settings.runs} timed runs, at least 5, within ${settings.budgetMs / 1000} s.`,
    `- Load average when each measured run started: ${Math.min(...loads).toFixed(2)} to ${Math.max(...loads).toFixed(2)}. Other containers on the machine during the runs, by image: ${ByImage(others)}.`,
  ];
}

interface PlanBlock {
  readonly engine: EngineId;
  readonly kind: QueryKind;
  readonly text: string;
}

function PlanBlocks(record: BenchRecord): PlanBlock[] {
  return record.engines.flatMap((engine) =>
    engine.plans.flatMap((plan) => {
      const query = record.cases.find((candidate) => candidate.id === plan.id);
      if (!query) {
        return [];
      }
      const statements = plan.statements.map((statement) => {
        const sql =
          statement.text.length > SQL_WIDTH
            ? `${statement.text.slice(0, SQL_WIDTH)} …(${statement.text.length} chars)`
            : statement.text;
        return ["```sql", sql, "```", "```text", statement.plan, "```"].join(
          "\n",
        );
      });
      const used = plan.statements.flatMap((statement) => statement.indexes);
      return [
        {
          engine: engine.id,
          kind: query.kind,
          text: [
            `<details><summary><code>${plan.id}</code>: declared index ${used.length > 0 ? [...new Set(used)].join(", ") : "not used"}</summary>`,
            "",
            ...statements,
            "",
            "</details>",
            "",
          ].join("\n"),
        },
      ];
    }),
  );
}

/** Writes the plan files, each under the size ceiling, and answers their names by engine and kind. */
function WritePlans(record: BenchRecord, root: string): Map<string, string[]> {
  const folder = path.join(root, PLANS_FOLDER);
  if (existsSync(folder)) {
    for (const file of readdirSync(folder)) rmSync(path.join(folder, file));
  }
  mkdirSync(folder, { recursive: true });
  const files = new Map<string, string[]>();
  const blocks = PlanBlocks(record);
  for (const engine of ENGINES) {
    for (const kind of KINDS) {
      const key = `${engine}-${kind}`;
      const parts: string[][] = [[]];
      const header = `# ${ENGINE_TITLES[engine]}: ${KIND_TITLES[kind]}\n\nThe statements the module sent, from the server's own log, and their plans. Back to [RESULTS.md](../${RESULTS}).\n\n`;
      for (const block of blocks.filter(
        (b) => b.engine === engine && b.kind === kind,
      )) {
        const current = parts[parts.length - 1];
        const size = Buffer.byteLength(header + current.join("") + block.text);
        if (current.length > 0 && size > PLAN_PART_BYTES)
          parts.push([block.text]);
        else current.push(block.text);
      }
      const names = parts.map((part, at) => {
        const name = parts.length > 1 ? `${key}-${at + 1}.md` : `${key}.md`;
        writeFileSync(path.join(folder, name), header + part.join(""));
        return name;
      });
      files.set(key, names);
    }
  }
  return files;
}

const METHOD = [
  '- **Data.** Each server holds the books twice, in `books_bare` (no index) and `books_indexed` (indexes `titleFr` on `title.fr` and `internalTitleFr` on `_internal.data.title.fr`), and as many reviews (the row count is in Environment). A book is written by `toDatabase` from a table class with two `@Localized({ fallbackLocale: "en" })` fields, so `_internal` is `{ meta: {}, data: { title: { fr, en }, summary: { fr, en } } }` as the decorators store it; the book also has a declared `title: { fr, en }` object of its own. Titles are a permutation of the ids, so the title order is not the id order. Every row is inserted through the module, never by SQL.',
  '- **Queries.** Each question is asked in each form the interface offers: `path` hands `orderBy` or `lookup` the dotted path (or the index name on `books_indexed`), `keys` chains `key()` in an expression, `decorators` is the expression `unlockrequest(LocalizedBook, row, "title", [{ modifier: LocalizationModifier, args: ["fr"] }])` builds, which reads `fr` with `.default()` to `en`. `orderBy` and `lookup` take only names, so the expression forms sort after a `map` and look up through `joinInner`.',
  "- **Client time** is the wall time of `await query.run()` in the bench module, in the same `ajs` process as the backend: compiling, the driver round trip and decoding. Median and p95 pool every timed run of every round; each round is a fresh `ajs` process per server, and the order of the servers rotates each round.",
  "- **Server time and rows read** come from a separate capture pass of 5 runs per query, never from the timed runs. MySQL and MariaDB: the slow log with `long_query_time = 0` (statement time, `rows_examined`). PostgreSQL: `auto_explain` with `log_analyze` and `log_timing = off` (executor time; rows read summed over the scan nodes, filtered rows included).",
  "- **Plans** are of the statements the module sent, as each server logged them. MySQL: `EXPLAIN FORMAT=TRADITIONAL` and `EXPLAIN ANALYZE` of the logged text, on a session given the module's own session pin. MariaDB has no `EXPLAIN ANALYZE`: it gets `EXPLAIN EXTENDED` (for the `filtered` column) and `ANALYZE`, whose table adds `r_rows` and `r_filtered`. PostgreSQL: the plan `auto_explain` logged for the module's execution, with its parameters. *Index used* means a declared index (`titleFr` or `internalTitleFr`) appears in the plan; postgres builds them on literal `_extra` keys, which no nested read can use.",
  "- **Correctness.** Every timed run's answer is compared with the ids the generator says it must be; ✗ marks a cell with any wrong run. The ratio divides a median of the MySQL family by the fastest **correct** postgres answer to the same question on the same table, in any form; *pg baseline* names that form.",
  "- **Tuning.** `innodb_buffer_pool_size = 1G` and `shared_buffers = 1GB`, so the 300k rows sit in memory on every server; `ANALYZE` on every table after seeding; every other setting is the image default. Each `ajs` run connects with the module's defaults.",
];

/** Writes RESULTS.md and the plan files from a run's record, with the authored findings. */
export function WriteReport(record: BenchRecord, root: string): void {
  const plans = WritePlans(record, root);
  const findingsPath = path.join(root, FINDINGS);
  const [summary = ""] = (
    existsSync(findingsPath) ? readFileSync(findingsPath, "utf8") : ""
  ).split("\n### ");
  const sections = KINDS.flatMap((kind) => [
    `### ${KIND_TITLES[kind]}`,
    "",
    "Median (p95) client ms per server.",
    "",
    ...KindTable(record, kind),
    "",
    "Plans: " +
      ENGINES.flatMap((engine) =>
        (plans.get(`${engine}-${kind}`) ?? []).map(
          (name) => `[${name.replace(/\.md$/, "")}](${PLANS_FOLDER}/${name})`,
        ),
      ).join(", ") +
      ".",
    "",
  ]);
  const server = KINDS.flatMap((kind) => [
    `### ${KIND_TITLES[kind]}`,
    "",
    ...ServerTable(record, kind),
    "",
  ]);
  const serverFile = "server.md";
  const comparison = Compared(record);
  if (comparison) {
    writeFileSync(
      path.join(root, PLANS_FOLDER, COMPARISON_FILE),
      comparison.file.join("\n"),
    );
  }
  writeFileSync(
    path.join(root, PLANS_FOLDER, serverFile),
    [
      "# Server time, rows read and round spread",
      "",
      `Server ms is the capture pass's median; client ms is the timed runs' median. Back to [RESULTS.md](../${RESULTS}).`,
      "",
      ...server,
    ].join("\n"),
  );
  const text = [
    "# Nested-field benchmark: @antelopejs/mysql against @antelopejs/postgres",
    "",
    "Generated by `pnpm run bench`; the findings are authored in [`findings.md`](findings.md), and their summary is copied in.",
    "",
    "## Environment",
    "",
    ...Environment(record),
    "",
    "## Method",
    "",
    ...METHOD,
    "",
    "## Results",
    "",
    `Server time, rows read and the spread of the rounds: [${PLANS_FOLDER}/${serverFile}](${PLANS_FOLDER}/${serverFile}).`,
    "",
    ...sections,
    ...(comparison?.section ?? []),
    summary.trim(),
    "",
    "The causes, section by section, are in [`findings.md`](findings.md).",
    "",
  ].join("\n");
  writeFileSync(path.join(root, RESULTS), text);
  Formatted(root, [
    RESULTS,
    ...[...plans.values()].flat().map((name) => path.join(PLANS_FOLDER, name)),
    path.join(PLANS_FOLDER, serverFile),
    ...(comparison ? [path.join(PLANS_FOLDER, COMPARISON_FILE)] : []),
  ]);
}

/**
 * Formats the written files as the repository's formatter does, then refuses any that the size
 * check would: a formatted table pads its cells, so the size is checked after formatting.
 */
function Formatted(root: string, files: readonly string[]): void {
  const paths = files.map((file) => path.join(root, file));
  execFileSync(path.join(root, "..", "node_modules", ".bin", "oxfmt"), paths, {
    stdio: "ignore",
  });
  for (const file of paths) {
    const bytes = statSync(file).size;
    if (bytes > SIZE_CEILING_BYTES) {
      throw new Error(
        `${file} is ${bytes} bytes, over the ${SIZE_CEILING_BYTES}-byte ceiling`,
      );
    }
  }
}
