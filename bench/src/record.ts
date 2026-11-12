import type { CasePlan, EngineId } from "./engine";
import type { QueryForm, QueryKind, FieldKey } from "./queries";
import type { CaseTimings, SeedOutput } from "./results";

/** The machine a run measured on. */
export interface MachineRecord {
  readonly cpu: string;
  readonly cores: number;
  readonly memoryGb: number;
  readonly kernel: string;
  readonly node: string;
  readonly docker: string;
}

/** The knobs of a run, from the environment or their defaults. */
export interface BenchSettings {
  readonly rows: number;
  readonly rounds: number;
  readonly runs: number;
  readonly budgetMs: number;
  readonly captureRuns: number;
}

/** One server: what it is, how it was seeded, and the plans of the statements the module sent it. */
export interface EngineRecord {
  readonly id: EngineId;
  readonly image: string;
  readonly digest: string;
  readonly version: string;
  readonly indexedTableDdl: string;
  readonly seed: SeedOutput;
  readonly plans: readonly CasePlan[];
}

/** One measured `ajs` run, with what shared the machine when it started. */
export interface RoundRecord {
  readonly round: number;
  readonly engine: EngineId;
  readonly loadAverage: string;
  readonly containers: readonly string[];
  readonly cases: readonly CaseTimings[];
}

export interface CaseRecord {
  readonly id: string;
  readonly kind: QueryKind;
  readonly field: FieldKey;
  readonly form: QueryForm;
  readonly indexed: boolean;
}

/** Everything one `pnpm run bench` measured, which the report is written from. */
export interface BenchRecord {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly machine: MachineRecord;
  readonly settings: BenchSettings;
  readonly cases: readonly CaseRecord[];
  readonly engines: readonly EngineRecord[];
  readonly rounds: readonly RoundRecord[];
}

interface RecordTimes {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly settings: object;
  readonly machine: object;
}

function HasTimes(value: unknown): value is RecordTimes {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "settings") &&
    Object.hasOwn(value, "machine") &&
    Object.hasOwn(value, "startedAt") &&
    Object.hasOwn(value, "finishedAt") &&
    "settings" in value &&
    "machine" in value &&
    "startedAt" in value &&
    "finishedAt" in value &&
    typeof value.settings === "object" &&
    typeof value.machine === "object" &&
    typeof value.startedAt === "string" &&
    typeof value.finishedAt === "string"
  );
}

/** Whether a value read back from `out/record.json` is a run's record: the fields the report reads. */
export function IsBenchRecord(value: unknown): value is BenchRecord {
  return (
    HasTimes(value) &&
    Object.hasOwn(value, "cases") &&
    Object.hasOwn(value, "engines") &&
    Object.hasOwn(value, "rounds") &&
    "cases" in value &&
    "engines" in value &&
    "rounds" in value &&
    Array.isArray(value.cases) &&
    Array.isArray(value.engines) &&
    Array.isArray(value.rounds)
  );
}
