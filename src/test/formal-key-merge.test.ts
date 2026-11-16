import type { ValueProxy } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";
import { expect } from "chai";

import { GetDialect, Read } from "../connection";
import { ident, param, sql } from "../statement";
import {
  CHAIN_KEY,
  DrawKeyedObject,
  DrawOperand,
  type KeyedObject,
  type KeyObject,
  type KeySpelling,
  type KeyValue,
  type Operand,
} from "./json-keys";
import { Random } from "./json-spell";
import { PhysicalTable, Run } from "./tables";

const SCHEMA_ID = "formal_key_merge";
const RUNS = Number(process.env.FORMAL_RUNS ?? 150);
const SEED = Number(process.env.FORMAL_SEED ?? 20_261_117);
const MAX_LEVELS = 40;
const SEED_RANGE = 2 ** 32;
const SHALLOW_LIMIT = 30;
const MAX_KEY_READS = 3;
const ABSENT_KEY = "no such key";
const ID = "doc";
const TEXT_LIMIT = 300;

interface Doc {
  _id: string;
  o: KeyObject;
  p: KeyObject;
  pick: string;
  merged?: KeyObject;
}

const schema = new Schema<{ docs: Doc }>(SCHEMA_ID, {
  docs: { fields: {}, indexes: {} },
});

function Docs() {
  return schema.instance().table("docs");
}

/** The objects and the constant one scenario merges, and the key it reads by a computed key. */
interface Scenario {
  readonly o: KeyedObject;
  readonly p: KeyedObject;
  readonly operand: Operand;
  readonly pick: string;
}

/** What one read of the module answers, as text, beside what a reader that keeps the last member gives. */
interface Check {
  readonly name: string;
  readonly read: () => Promise<string>;
  readonly wanted: string;
}

function IsObject(value: KeyValue | undefined): value is KeyObject {
  return (
    value !== null &&
    value !== undefined &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** `value` as JSON text with each object's keys in order, so two readings of one value share a text. */
function Canonical(value: KeyValue | undefined): string {
  if (Array.isArray(value)) {
    return `[${value.map(Canonical).join(",")}]`;
  }
  if (IsObject(value)) {
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${Canonical(value[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** What a reader that keeps the last member of a repeated key makes of `left` merged with `right`. */
function Merged(left: KeyObject, right: KeyObject): KeyObject {
  return { ...left, ...right };
}

function Draw(seed: number, spelling: KeySpelling): Scenario {
  const next = Random(seed);
  const level = () => Math.floor(next() * MAX_LEVELS);
  const o = DrawKeyedObject(Math.floor(next() * SEED_RANGE), level(), spelling);
  const p = DrawKeyedObject(Math.floor(next() * SEED_RANGE), level(), spelling);
  const operand = DrawOperand(Math.floor(next() * SEED_RANGE));
  const keys = Object.keys(Merged(o.value, p.value));
  return { o, p, operand, pick: keys[Math.floor(next() * keys.length)] };
}

/** Whether a read of `scenario` may fail as nested too deep: only MariaDB 11.8 builds fewer than 32 levels. */
async function MayRefuse(scenario: Scenario): Promise<boolean> {
  if (GetDialect().id !== "mariadb") {
    return false;
  }
  const [version] = await Read(sql`SELECT VERSION() AS v`);
  return (
    String(version?.get("v")).startsWith("11.8.") &&
    Math.max(scenario.o.depth, scenario.p.depth) >= SHALLOW_LIMIT
  );
}

/** What `pending` answers, or `too deep` where it fails as nested too deep. */
async function Answer(pending: Promise<string>): Promise<string> {
  return pending.catch((err: unknown) => {
    if (err instanceof Error && GetDialect().capture.tooDeep(err)) {
      return "too deep";
    }
    throw err;
  });
}

/** Writes the row as another writer would; answers `false` where the server refused a document nested that deep, which stores no row. */
async function Store(scenario: Scenario, refuses: boolean): Promise<boolean> {
  await Docs().delete().run();
  const text = `{"o":${scenario.o.text},"p":${scenario.p.text},"pick":${JSON.stringify(scenario.pick)}}`;
  try {
    await Run(
      sql`INSERT INTO ${ident(PhysicalTable(SCHEMA_ID, "docs"))} (_id, _instance, _extra) VALUES (${param(ID)}, '', ${param(text)})`,
    );
    return true;
  } catch (err) {
    if (
      refuses &&
      err instanceof Error &&
      err.message.startsWith("CONSTRAINT ")
    ) {
      return false;
    }
    throw err;
  }
}

async function StoredText(): Promise<string> {
  const [row] = await Read(
    sql`SELECT CAST(${ident("_extra")} AS CHAR) AS text FROM ${ident(PhysicalTable(SCHEMA_ID, "docs"))} WHERE ${ident("_id")} = ${param(ID)}`,
  );
  return String(row?.get("text"));
}

/** The objects `value` nests one inside the other under {@link CHAIN_KEY}, the first as the root. */
function Chain(value: KeyObject): KeyObject[] {
  const chain = [value];
  for (let next = value[CHAIN_KEY]; IsObject(next); next = next[CHAIN_KEY]) {
    chain.push(next);
  }
  return chain;
}

function Rows() {
  return Docs().getAll(ID);
}

/** Reads of members of the stored `o` itself, which MariaDB takes from the first of a key written twice. */
function MemberChecks(scenario: Scenario): Check[] {
  const { o } = scenario;
  const hops = Chain(o.value).length - 1;
  const deepest = Chain(o.value).at(-1) ?? {};
  const keys = Object.keys(o.value).slice(0, MAX_KEY_READS);
  return [
    ...keys.map((key) => ({
      name: `key ${JSON.stringify(key)} of the stored object`,
      read: async () =>
        Canonical(
          await Rows()
            .map((row) => row.key("o").key(key))
            .run(),
        ),
      wanted: Canonical([o.value[key]]),
    })),
    {
      name: `${hops} hops down the chain`,
      read: async () =>
        Canonical(
          await Rows()
            .map((row) =>
              Array.from({ length: hops }).reduce<ValueProxy<KeyObject>>(
                (value) => value.key(CHAIN_KEY).cast<KeyObject>(),
                row.key("o"),
              ),
            )
            .run(),
        ),
      wanted: Canonical([deepest]),
    },
  ];
}

/** Each read of `o`, `p` and their merge that the module answers, beside what a last-member-wins reader gives. */
function Checks(scenario: Scenario, readsMembers: boolean): Check[] {
  const merged = Merged(scenario.o.value, scenario.p.value);
  const withOperand = Merged(scenario.o.value, scenario.operand);
  const keys = [scenario.pick, ...Object.keys(merged), ABSENT_KEY].slice(
    0,
    MAX_KEY_READS,
  );
  const readMerged = () =>
    Rows().map((row) => row.key("o").merge(row.key("p")).cast<KeyObject>());
  return [
    {
      name: "whole",
      read: async () => {
        const row = await Docs().get(ID).run();
        return Canonical([row?.o ?? null, row?.p ?? null]);
      },
      wanted: Canonical([scenario.o.value, scenario.p.value]),
    },
    {
      name: "merge of two stored objects",
      read: async () => Canonical(await readMerged().run()),
      wanted: Canonical([merged]),
    },
    {
      name: "merge of a constant",
      read: async () =>
        Canonical(
          await Rows()
            .map((row) =>
              row.key("o").merge(scenario.operand).cast<KeyObject>(),
            )
            .run(),
        ),
      wanted: Canonical([withOperand]),
    },
    ...keys.map((key) => ({
      name: `key ${JSON.stringify(key)} of a merge`,
      read: async () =>
        Canonical(
          await Rows()
            .map((row) =>
              row.key("o").merge(row.key("p")).cast<KeyObject>().key(key),
            )
            .run(),
        ),
      wanted: Canonical([merged[key]]),
    })),
    {
      name: "computed key of a merge",
      read: async () =>
        Canonical(
          await Rows()
            .map((row) =>
              row
                .key("o")
                .merge(row.key("p"))
                .cast<KeyObject>()
                .key(row.key("pick").cast<string>()),
            )
            .run(),
        ),
      wanted: Canonical([merged[scenario.pick]]),
    },
    ...(readsMembers ? MemberChecks(scenario) : []),
  ];
}

async function Update(): Promise<string> {
  await Docs()
    .get(ID)
    .update((row) => ({
      merged: row.key("o").merge(row.key("p")).cast<KeyObject>(),
    }))
    .run();
  return "written";
}

/** What the module answers that a last-member-wins reader does not, or `undefined` where every read agrees. */
async function Disagreement(scenario: Scenario): Promise<string | undefined> {
  const refuses = await MayRefuse(scenario);
  if (!(await Store(scenario, refuses))) {
    return (await Docs().count().run()) === 0
      ? undefined
      : "store: a refused document left a row";
  }
  const readsMembers = GetDialect().id === "mysql" || !scenario.o.repeats;
  for (const { name, read, wanted } of Checks(scenario, readsMembers)) {
    const got = await Answer(read());
    if (got !== wanted && !(got === "too deep" && refuses)) {
      return `${name}: read ${got.slice(0, TEXT_LIMIT)}, a last-member-wins reader gives ${wanted.slice(0, TEXT_LIMIT)}`;
    }
  }
  const before = await StoredText();
  if ((await Answer(Update())) === "too deep") {
    return refuses && (await StoredText()) === before
      ? undefined
      : "update: failed as too deep where it may not, or changed the row";
  }
  const stored = Canonical((await Docs().get(ID).run())?.merged);
  const wanted = Canonical(Merged(scenario.o.value, scenario.p.value));
  return stored === wanted
    ? undefined
    : `update: stored ${stored.slice(0, TEXT_LIMIT)}, a last-member-wins reader gives ${wanted.slice(0, TEXT_LIMIT)}`;
}

describe("a merge and a key read of an object with escaped, repeated and deeply nested keys", function () {
  this.timeout(600_000);

  before(async () => {
    await schema.createInstance("one").run();
  });

  after(async () => {
    await schema.destroyInstance("one").run();
  });

  it("keeps the last member of a repeated key at every depth, or fails as too deep and changes no row", async () => {
    const spelling: KeySpelling = { escapeAscii: GetDialect().id === "mysql" };
    for (let run = 0; run < RUNS; run += 1) {
      const scenario = Draw(SEED + run, spelling);
      const why = await Disagreement(scenario);
      if (why !== undefined) {
        expect.fail(
          `seed ${SEED + run}, depths ${scenario.o.depth} and ${scenario.p.depth}: ${why}\no=${scenario.o.text.slice(0, 400)}\np=${scenario.p.text.slice(0, 400)}`,
        );
      }
    }
  });
});
