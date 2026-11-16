import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

import { GetDialect } from "../connection";
import { type Sql, ident, join, param, sql } from "../statement";
import { DrawMaybeTemplate } from "./json-draw";
import {
  ClassOf,
  Equal,
  IsWideNumber,
  type Json,
  NestsWideNumber,
  Order,
  type Template,
  type Written,
} from "./json-model";
import { Random, Spell, type Spelling } from "./json-spell";
import { PhysicalTable, Run } from "./tables";

const SCHEMA_ID = "formal_json_identity";
const RUNS = Number(process.env.FORMAL_RUNS ?? 300);
const SEED = Number(process.env.FORMAL_SEED ?? 20_261_116);
const MAX_POOL = 5;
const MAX_ROWS = 8;
const SEED_RANGE = 2 ** 32;
const GROUPS = ["p", "q"] as const;

type Group = (typeof GROUPS)[number];

interface Item {
  _id: string;
  v?: string;
  w?: string;
  g: Group;
}

const schema = new Schema<{ items: Item }>(SCHEMA_ID, {
  items: { fields: {}, indexes: {} },
});

function Items() {
  return schema.instance().table("items");
}

/** A row as another writer stores it: two undeclared values, each as text, and a group. */
interface Stored {
  readonly id: string;
  readonly group: Group;
  readonly v: Written;
  readonly w: Written;
}

/** What one read of the module answers, as text, beside what MySQL's JSON comparison gives. */
interface Read {
  readonly name: string;
  readonly read: () => Promise<string>;
  readonly wanted: string;
}

/** MariaDB keeps a document as written, so the text of one value varies only in its numbers there. */
function SpellingOfEngine(): Spelling {
  const free = GetDialect().id === "mysql";
  return { escapes: free, keyOrder: free };
}

function Spelt(
  template: Template | undefined,
  seed: number,
  spelling: Spelling,
): Written {
  return template === undefined
    ? { json: undefined, text: undefined }
    : Spell(template, seed, spelling);
}

/** The rows a seed draws: a pool of templates, each row spelling two of them as it likes. */
function Draw(seed: number, spelling: Spelling): Stored[] {
  const next = Random(seed);
  const pool = Array.from({ length: 1 + Math.floor(next() * MAX_POOL) }, () =>
    DrawMaybeTemplate(next),
  );
  const rows = 2 + Math.floor(next() * (MAX_ROWS - 1));
  const spelled = () =>
    Spelt(
      pool[Math.floor(next() * pool.length)],
      Math.floor(next() * SEED_RANGE),
      spelling,
    );
  return Array.from({ length: rows }, (_, at) => ({
    id: String(at),
    group: GROUPS[Math.floor(next() * GROUPS.length)],
    v: spelled(),
    w: spelled(),
  }));
}

/** The JSON object a row stores in its overflow column, each value parsed by the server from its text. */
function Extra(row: Stored): Sql {
  const pairs = [sql`'g'`, param(row.group)];
  for (const [key, value] of [
    ["v", row.v],
    ["w", row.w],
  ] as const) {
    if (value.text !== undefined) {
      pairs.push(
        sql`${param(key)}`,
        sql`JSON_EXTRACT(${param(value.text)}, '$')`,
      );
    }
  }
  return sql`JSON_OBJECT(${join(pairs, sql`, `)})`;
}

async function Load(rows: readonly Stored[]): Promise<void> {
  await Items().delete().run();
  const values = rows.map((row) => sql`(${param(row.id)}, '', ${Extra(row)})`);
  await Run(
    sql`INSERT INTO ${ident(PhysicalTable(SCHEMA_ID, "items"))} (_id, _instance, _extra) VALUES ${join(values, sql`, `)}`,
  );
}

function Part(ids: readonly string[]): string {
  return [...ids].sort().join(",");
}

/** The rows that share a value, as MySQL's JSON comparison finds them. */
function PartitionOf(rows: readonly Stored[]): string {
  const parts = new Map<string, string[]>();
  for (const row of rows) {
    const key = ClassOf(row.v.json);
    parts.set(key, [...(parts.get(key) ?? []), row.id]);
  }
  return JSON.stringify([...parts.values()].map(Part).sort());
}

async function Grouped(): Promise<string> {
  const groups = await Items()
    .group("v", (stream) => ({ ids: stream.map((item) => item.key("_id")) }))
    .run();
  return JSON.stringify(groups.map(({ ids }) => Part(ids)).sort());
}

/** The distinct values of each group, by the classes MySQL's JSON comparison finds. */
function DistinctCountsOf(rows: readonly Stored[]): string {
  const classes = new Map<Group, Set<string>>();
  for (const row of rows) {
    const seen = classes.get(row.group) ?? new Set<string>();
    seen.add(ClassOf(row.v.json));
    classes.set(row.group, seen);
  }
  return JSON.stringify(GROUPS.map((group) => classes.get(group)?.size ?? 0));
}

async function DistinctCounts(): Promise<string> {
  const groups = await Items()
    .group("g", (stream, group) => ({
      group,
      values: stream.distinct("v"),
    }))
    .run();
  return JSON.stringify(
    GROUPS.map(
      (group) =>
        groups.find((read) => read.group === group)?.values.length ?? 0,
    ),
  );
}

function EqualIdsOf(rows: readonly Stored[]): string {
  return JSON.stringify(
    rows
      .filter(
        (row) =>
          row.v.json !== undefined &&
          row.w.json !== undefined &&
          Equal(row.v.json, row.w.json),
      )
      .map((row) => row.id)
      .sort(),
  );
}

async function EqualIds(): Promise<string> {
  const ids = await Items()
    .filter((item) => item.key("v").eq(item.key("w")))
    .map((item) => item.key("_id"))
    .run();
  return JSON.stringify([...ids].sort());
}

function JoinedPairsOf(rows: readonly Stored[]): string {
  return JSON.stringify(
    rows
      .flatMap((left) =>
        rows
          .filter(
            (right) =>
              left.v.json !== undefined &&
              right.v.json !== undefined &&
              Equal(left.v.json, right.v.json),
          )
          .map((right) => `${left.id}-${right.id}`),
      )
      .sort(),
  );
}

async function JoinedPairs(): Promise<string> {
  const pairs = await Items()
    .joinInner(
      Items(),
      (left, right) => left.key("v").eq(right.key("v")),
      (left, right) => ({ left: left.key("_id"), right: right.key("_id") }),
    )
    .run();
  return JSON.stringify(
    pairs.map(({ left, right }) => `${left}-${right}`).sort(),
  );
}

async function Sorted(direction: "asc" | "desc"): Promise<string[]> {
  const items = await Items().orderBy("v", direction).run();
  return items.map((item) => item._id);
}

/**
 * The first two rows in `ids` that the order puts the wrong way round, or `undefined`. MariaDB
 * orders two numbers past 2^53 by their double and then their text, so it leaves them out.
 */
function Inverted(
  ids: readonly string[],
  rows: readonly Stored[],
  sign: 1 | -1,
): string | undefined {
  const byId = new Map<string, Json | undefined>(
    rows.map((row) => [row.id, row.v.json]),
  );
  const skipWide = GetDialect().id === "mariadb";
  for (const [first, left] of ids.entries()) {
    for (const right of ids.slice(first + 1)) {
      const [a, b] = [byId.get(left), byId.get(right)];
      const order = Order(a, b);
      const wide = IsWideNumber(a) && IsWideNumber(b);
      if (order !== undefined && order * sign > 0 && !(skipWide && wide)) {
        return `${left} before ${right}`;
      }
    }
  }
  return undefined;
}

/** What the module answers that MySQL's JSON comparison does not, or `undefined` where every read agrees. */
async function Disagreement(
  rows: readonly Stored[],
): Promise<string | undefined> {
  await Load(rows);
  const splitsNestedWide =
    GetDialect().id === "mysql" &&
    rows.some((row) => NestsWideNumber(row.v.json));
  const reads: Read[] = [
    { name: "distinct", read: DistinctCounts, wanted: DistinctCountsOf(rows) },
    { name: "eq", read: EqualIds, wanted: EqualIdsOf(rows) },
    { name: "join", read: JoinedPairs, wanted: JoinedPairsOf(rows) },
  ];
  if (!splitsNestedWide) {
    reads.unshift({ name: "group", read: Grouped, wanted: PartitionOf(rows) });
  }
  for (const { name, read, wanted } of reads) {
    const got = await read();
    if (got !== wanted) {
      return `${name}: read ${got}, MySQL's comparison gives ${wanted}`;
    }
  }
  for (const direction of ["asc", "desc"] as const) {
    const ids = await Sorted(direction);
    const inverted = Inverted(ids, rows, direction === "asc" ? 1 : -1);
    if (inverted !== undefined || ids.length !== rows.length) {
      return `orderBy ${direction}: read ${ids.join(",")}, which puts ${inverted ?? "a row twice"} the wrong way round`;
    }
  }
  return undefined;
}

/** The fewest rows of `rows` that still disagree, dropping one row at a time. */
async function Shrunk(rows: readonly Stored[]): Promise<Stored[]> {
  let kept = [...rows];
  for (let at = 0; at < kept.length;) {
    const fewer = kept.filter((_, index) => index !== at);
    if (fewer.length > 0 && (await Disagreement(fewer)) !== undefined) {
      kept = fewer;
    } else {
      at += 1;
    }
  }
  return kept;
}

function Describe(rows: readonly Stored[]): string {
  return rows
    .map((row) =>
      `${row.id} ${row.group} v=${row.v.text ?? "absent"} w=${row.w.text ?? "absent"}`.slice(
        0,
        200,
      ),
    )
    .join("\n");
}

/** Rows of one group that store each text as `v`, with no `w`. */
function Pinned(texts: readonly string[]): Stored[] {
  return texts.map((text, at) => ({
    id: String(at),
    group: "p",
    v: { json: undefined, text },
    w: { json: undefined, text: undefined },
  }));
}

describe("the identity of a JSON value another writer spelled", function () {
  this.timeout(600_000);

  before(async () => {
    await schema.createInstance("one").run();
  });

  after(async () => {
    await schema.destroyInstance("one").run();
  });

  it("partitions by group, distinct, eq and a hashed join as MySQL's JSON comparison does, and sorts without inverting it", async () => {
    for (let run = 0; run < RUNS; run += 1) {
      const rows = Draw(SEED + run, SpellingOfEngine());
      if ((await Disagreement(rows)) !== undefined) {
        const small = await Shrunk(rows);
        expect.fail(
          `seed ${SEED + run}: ${await Disagreement(small)}\n${Describe(small)}`,
        );
      }
    }
  });

  describe("known findings, each of which still reproduces", () => {
    it("groups arrays of one double beside the array of the integer next to it as three groups on MySQL, where JSON = finds two", async () => {
      await Load(
        Pinned([
          "[9223372036854775808e0]",
          "[9223372036854775808]",
          "[9223372036854775808E+0]",
        ]),
      );
      expect(await Grouped()).to.equal(
        GetDialect().id === "mysql"
          ? JSON.stringify(["0", "1", "2"])
          : JSON.stringify(["0,2", "1"]),
      );
    });

    it("sorts the integer 2^53 + 1 before the double 2^53 on MariaDB, where MySQL sorts it after", async () => {
      await Load(Pinned(["9007199254740993", "9007199254740992e0"]));
      expect(await Sorted("asc")).to.deep.equal(
        GetDialect().id === "mariadb" ? ["0", "1"] : ["1", "0"],
      );
    });
  });
});
