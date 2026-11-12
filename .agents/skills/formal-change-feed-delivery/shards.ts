/**
 * Splits the drawn scenarios across worker threads and merges what they report. Each thread is its
 * own isolate with its own feed registry and fake server, so scenarios never share state. The
 * merge reads the results in scenario order, stops after the first scenario that breaks a rule
 * outside the findings, and gives each rule the counterexample of the shortest trace, the lowest
 * scenario on a tie: the output is the same for any `--jobs`.
 */
import { Worker } from "node:worker_threads";

/** A rule's counterexample: the length of its trace, and the run as the check prints it. */
export interface Counterexample {
  readonly length: number;
  readonly text: string;
}

/** What exploring one scenario found. */
export interface ScenarioResult {
  readonly index: number;
  readonly orders: number;
  readonly covered: number;
  readonly exhausted: boolean;
  /** Whether a rule outside the findings broke. */
  readonly broken: boolean;
  readonly counterexamples: readonly (readonly [string, Counterexample])[];
}

/** The merged exploration. */
export interface Exploration {
  readonly found: ReadonlyMap<string, Counterexample>;
  readonly orders: number;
  readonly covered: number;
  readonly cut: number;
  readonly explored: number;
}

/** Which scenarios a thread explores: every `jobs`-th one from `index`. */
export interface Shard {
  readonly index: number;
  readonly jobs: number;
}

export function mergeResults(results: readonly ScenarioResult[], total: number): Exploration {
  const byIndex = new Map(results.map((result) => [result.index, result]));
  const found = new Map<string, Counterexample>();
  let orders = 0;
  let covered = 0;
  let cut = 0;
  let explored = 0;
  for (let index = 0; index < total; index += 1) {
    const result = byIndex.get(index);
    if (!result) {
      break;
    }
    for (const [rule, counterexample] of result.counterexamples) {
      if (counterexample.length < (found.get(rule)?.length ?? Infinity)) {
        found.set(rule, counterexample);
      }
    }
    orders += result.orders;
    covered += result.covered;
    cut += result.exhausted ? 0 : 1;
    explored += 1;
    if (result.broken) {
      break;
    }
  }
  return { found, orders, covered, cut, explored };
}

/** Explores the scenarios of `shard` in order, and stops after one that breaks a rule outside the findings. */
export async function exploreShard(
  total: number,
  shard: Shard,
  explore: (index: number) => Promise<ScenarioResult>,
  report: (result: ScenarioResult) => void,
): Promise<void> {
  for (let index = shard.index; index < total; index += shard.jobs) {
    const result = await explore(index);
    report(result);
    if (result.broken) {
      return;
    }
  }
}

/** Runs `file` in `jobs` worker threads, each told its 1-based shard by `--shard`, and gathers every result they post. */
export function runShards(file: string, argv: readonly string[], jobs: number): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  const workers = Array.from({ length: jobs }, (_, index) => {
    const worker = new Worker(file, { argv: [...argv, "--shard", String(index + 1)] });
    worker.on("message", (result: ScenarioResult) => results.push(result));
    return new Promise<void>((resolve, reject) => {
      worker.on("error", reject);
      worker.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${index} exited with ${code}`))));
    });
  });
  return Promise.all(workers).then(() => results);
}
