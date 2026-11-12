import { QueryStage } from "@antelopejs/interface-database/common";
import type { InstanceId } from "@antelopejs/interface-database/schema";

import { Bind, type Bound, type SqlValue } from "../../statement";
import type { Row } from "../../connection";
import { DIALECTS } from "../../dialect";
import {
  ClearOptions,
  GetOptions,
  type ResolvedOptions,
  SetOptions,
} from "../../config";
import { ParseTable } from "../../implementations/database/fields";
import { BuildTablePlan } from "../../implementations/database/plan";
import type { TableOrigin } from "../../implementations/database/relation";
import {
  CloseOneFeed,
  type FeedEnvironment,
  ReadFeedEvent,
} from "../../implementations/database/feeds";
import type { RowObject } from "../../implementations/database/result";

/**
 * Feeds that never open against a live schema, driven entirely through the environment seam.
 *
 * These `reqId`s are negative because the interface's own counter starts at 0 and counts up, so a
 * fixture using a positive id would collide with a cursor the process allocated for something else.
 */
let nextReqId = -1000;
export const NewReqId = () => nextReqId--;

export const SCHEMA_ID = "shop";
export const TABLE_ID = "orders";
export const EPOCH = "6f1c1f0e-0000-4000-8000-000000000001";
export const LATER_EPOCH = "6f1c1f0e-0000-4000-8000-000000000002";

/** Long enough for a feed to open and poll once, far shorter than its fallback wait. */
const SETTLE_MS = 60;

const DEFINITION = { fields: {}, indexes: {} };

/**
 * A table with no declared fields, so every logged key reads out of the overflow document. `index`
 * answers the name itself, which is the undeclared-field fallback the read path takes too.
 */
const FIELDLESS: TableOrigin = {
  schemaId: SCHEMA_ID,
  tableId: TABLE_ID,
  model: { fields: {} },
  plan: BuildTablePlan(
    SCHEMA_ID,
    TABLE_ID,
    DEFINITION,
    ParseTable(DEFINITION, `${SCHEMA_ID}.${TABLE_ID}`),
    { prefix: "", session: DIALECTS.mysql.session },
  ).plan,
  index: (name) => [name],
};

/** A document a side projects, as these specs write them. */
type Doc = Readonly<Record<string, string | number>>;

/** One side of a logged event as the poll answers it: what it projected, and whether it matched. */
interface Side {
  readonly doc: Doc;
  readonly matched: boolean;
}

export function Matched(doc: Doc, matched = true): Side {
  return { doc, matched };
}

interface Event {
  readonly seq: number;
  readonly op: string;
  readonly old?: Side;
  readonly new?: Side;
}

/** What one poll answers; anything left out reads as an unchanged log with nothing new. */
export interface Answer {
  readonly epoch?: string;
  readonly frontier?: number;
  readonly highWater?: number;
  readonly events?: readonly Event[];
}

type Cell = string | number | null;

function SideCell(side: Side | undefined): Cell {
  return side ? JSON.stringify(side) : null;
}

function PollRows(answer: Answer, frontier: number): Row[] {
  const header = {
    epoch: answer.epoch ?? EPOCH,
    frontier: String(answer.frontier ?? frontier),
    high_water:
      answer.highWater === undefined ? null : String(answer.highWater),
  };
  const events = answer.events ?? [];
  const cells: Record<string, Cell>[] =
    events.length === 0
      ? [{ ...header, seq: null, op: null, old_side: null, new_side: null }]
      : events.map((event) => ({
          ...header,
          seq: String(event.seq),
          op: event.op,
          old_side: SideCell(event.old),
          new_side: SideCell(event.new),
        }));
  return cells.map((row) => new Map(Object.entries(row)));
}

/**
 * An environment whose log opens at `opened` and answers each poll in turn, the last answer
 * repeating. It records every poll it was asked, and the subscriptions the feed held.
 */
export function Reader(answers: readonly Answer[], opened = 0) {
  const asked: Bound[] = [];
  const wakes: (() => void)[] = [];
  let unsubscribed = 0;
  const env: FeedEnvironment = {
    dialect: () => DIALECTS.mysql,
    origin: () => FIELDLESS,
    install: () => Promise.resolve(),
    open: () =>
      Promise.resolve({
        epoch: EPOCH,
        frontier: BigInt(opened),
        pending: false,
      }),
    read: (statement) => {
      asked.push(Bind(statement));
      const answer = answers[Math.min(asked.length - 1, answers.length - 1)];
      return Promise.resolve(PollRows(answer ?? {}, opened));
    },
    subscribe: (_table, wake) => {
      wakes.push(wake);
      return () => {
        unsubscribed += 1;
      };
    },
  };
  return { env, asked, wakes, unsubscribed: () => unsubscribed };
}

/** The value a poll binds last: the `seq` it reads after. */
export function After(bound: Bound | undefined): SqlValue | undefined {
  return bound?.args.at(-1);
}

function CurrentOptions(): ResolvedOptions | undefined {
  try {
    return GetOptions();
  } catch {
    return undefined;
  }
}

/**
 * Runs an asynchronous body with *a* configuration in place, leaving an existing one alone: under
 * `ajs module test` the live adapter configured this process and nothing is changed, and under a
 * standalone unit run there is no registration to observe the set.
 */
export async function WhileConfigured<T>(body: () => Promise<T>): Promise<T> {
  if (CurrentOptions()) {
    return body();
  }
  SetOptions({});
  try {
    return await body();
  } finally {
    ClearOptions();
  }
}

export function Stages(
  instance: InstanceId | undefined,
  ...between: QueryStage[]
): QueryStage[] {
  return [
    QueryStage("schema", { id: SCHEMA_ID }),
    QueryStage("instance", { id: instance }),
    QueryStage("table", { id: TABLE_ID }),
    ...between,
    QueryStage("changes"),
  ];
}

/** Runs a feed spec with a configuration in place, and closes the feed however it ends. */
export function Feed<T>(body: (reqId: number) => Promise<T>) {
  const reqId = NewReqId();
  return WhileConfigured(() => body(reqId)).finally(() => CloseOneFeed(reqId));
}

/** Reads one event of the default instance's feed, with the environment supplied. */
export function Step(
  reqId: number,
  env: FeedEnvironment,
  ...between: QueryStage[]
): Promise<IteratorResult<RowObject, void>> {
  return ReadFeedEvent(reqId, Stages("default", ...between), env);
}

/** Lets a feed that has nothing to deliver open and poll, then stops waiting on its read. */
export function Settled<T>(pending: Promise<T>): Promise<T | undefined> {
  return Promise.race([
    pending,
    new Promise<undefined>((resolve) => {
      setTimeout(() => resolve(undefined), SETTLE_MS);
    }),
  ]);
}
