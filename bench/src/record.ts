import { PATHS } from "./dataset";
import type { CasePlan, EngineId, StatementPlan } from "./engine";
import { ENGINE_TITLES } from "./format";
import {
  ArrayOf,
  IsBoolean,
  IsNumber,
  IsString,
  Member,
  Optional,
  Fields,
} from "./guard";
import type { QueryForm, QueryKind, FieldKey } from "./queries";
import {
  IsCaseTimings,
  IsSeedOutput,
  type CaseTimings,
  type SeedOutput,
} from "./results";

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
  /** The run loaded the base checkout (`BENCH_BASE`), not the code under test. */
  readonly base: boolean;
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
  /** The commit of the base checkout each round measured beside the code under test, if any. */
  readonly baseRevision: string | undefined;
}

const IsEngineId = Member(ENGINE_TITLES);

const QUERY_KINDS: Readonly<Record<QueryKind, true>> = {
  filter: true,
  orderBy: true,
  lookup: true,
};

const QUERY_FORMS: Readonly<Record<QueryForm, true>> = {
  path: true,
  keys: true,
  decorators: true,
};

const IsEngineRecord = Fields<EngineRecord>({
  id: IsEngineId,
  image: IsString,
  digest: IsString,
  version: IsString,
  indexedTableDdl: IsString,
  seed: IsSeedOutput,
  plans: ArrayOf(
    Fields<CasePlan>({
      id: IsString,
      statements: ArrayOf(
        Fields<StatementPlan>({
          text: IsString,
          plan: IsString,
          indexes: ArrayOf(IsString),
        }),
      ),
      serverMs: ArrayOf(IsNumber),
      rowsExamined: ArrayOf(IsNumber),
      logged: IsNumber,
    }),
  ),
});

/**
 * Whether a value read back from `out/record.json` is a run's record, every nested field included.
 * A run without a base writes no `baseRevision`.
 */
export const IsBenchRecord = Fields<BenchRecord>({
  startedAt: IsString,
  finishedAt: IsString,
  machine: Fields<MachineRecord>({
    cpu: IsString,
    cores: IsNumber,
    memoryGb: IsNumber,
    kernel: IsString,
    node: IsString,
    docker: IsString,
  }),
  settings: Fields<BenchSettings>({
    rows: IsNumber,
    rounds: IsNumber,
    runs: IsNumber,
    budgetMs: IsNumber,
    captureRuns: IsNumber,
  }),
  cases: ArrayOf(
    Fields<CaseRecord>({
      id: IsString,
      kind: Member(QUERY_KINDS),
      field: Member(PATHS),
      form: Member(QUERY_FORMS),
      indexed: IsBoolean,
    }),
  ),
  engines: ArrayOf(IsEngineRecord),
  rounds: ArrayOf(
    Fields<RoundRecord>({
      round: IsNumber,
      engine: IsEngineId,
      loadAverage: IsString,
      containers: ArrayOf(IsString),
      cases: ArrayOf(IsCaseTimings),
      base: IsBoolean,
    }),
  ),
  baseRevision: Optional(IsString),
});
