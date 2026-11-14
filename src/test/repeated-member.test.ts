import { expect } from "chai";
import type { ValueProxy } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";

import { GetDialect, Read } from "../connection";
import { ident, param, sql } from "../statement";
import { WaitForIndexes } from "../implementations/database/schema";
import { PhysicalTable, Run } from "./tables";

const SCHEMA_ID = "repeated_member";
const INSTANCE = "one";

interface Doc {
  _id: string;
  o?: Record<string, string>;
  p?: Record<string, string>;
}

interface Side {
  _id: string;
  v: string;
}

const schema = new Schema<{ bare: Doc; indexed: Doc; side: Side }>(SCHEMA_ID, {
  bare: { fields: {}, indexes: {} },
  indexed: { fields: {}, indexes: { o: { fields: ["o.é"] } } },
  side: { fields: {}, indexes: {} },
});

type TableId = "bare" | "indexed";

const TABLES: readonly TableId[] = ["bare", "indexed"];

/** Objects naming `é` twice, as a writer other than the module may store them: `x` first, `g` last. */
const STORED = {
  plain: '{"o": {"é": "x", "é": "g"}}',
  escapedFirst: '{"o": {"\\u00e9": "x", "é": "g"}}',
  escapedLast: '{"o": {"é": "x", "\\u00e9": "g"}}',
} as const;

type Id = keyof typeof STORED;

const IDS: Id[] = ["escapedFirst", "escapedLast", "plain"];

interface Filtered {
  equalsX: Id[];
  equalsG: Id[];
  notEqualsG: Id[];
  unequalG: Id[];
}

interface Reads {
  member: Record<Id, string>;
  merged: Record<Id, string>;
  keys: Record<Id, string[]>;
  values: string[];
  indexedG: Id[];
  filtered: Record<TableId, Filtered>;
  joined: Record<"g" | "x", Id[]>;
  equalsObject: Id[];
  distinctObjects: number;
}

const LAST: Filtered = {
  equalsX: [],
  equalsG: IDS,
  notEqualsG: [],
  unequalG: [],
};

/** What each read answers, as `docs/mariadb-repeated-keys.md` states it. */
const EXPECTED: Readonly<Record<"mysql" | "mariadb", Reads>> = {
  mysql: {
    member: { plain: "g", escapedFirst: "g", escapedLast: "g" },
    merged: { plain: "g", escapedFirst: "g", escapedLast: "g" },
    keys: { plain: ["é"], escapedFirst: ["é"], escapedLast: ["é"] },
    values: ["g"],
    indexedG: IDS,
    filtered: { bare: LAST, indexed: LAST },
    joined: { g: IDS, x: [] },
    equalsObject: IDS,
    distinctObjects: 1,
  },
  mariadb: {
    member: { plain: "x", escapedFirst: "g", escapedLast: "x" },
    merged: { plain: "g", escapedFirst: "g", escapedLast: "g" },
    keys: { plain: ["é"], escapedFirst: ["é", "é"], escapedLast: ["é", "é"] },
    values: ["x", "g"],
    indexedG: ["escapedFirst"],
    filtered: {
      bare: {
        equalsX: ["escapedLast", "plain"],
        equalsG: [],
        notEqualsG: IDS,
        unequalG: ["escapedLast", "plain"],
      },
      indexed: {
        equalsX: ["escapedLast", "plain"],
        equalsG: ["escapedFirst"],
        notEqualsG: ["escapedLast", "plain"],
        unequalG: ["escapedLast", "plain"],
      },
    },
    joined: { g: ["escapedFirst"], x: ["escapedLast", "plain"] },
    equalsObject: [],
    distinctObjects: 3,
  },
};

function Table(table: TableId) {
  return schema.instance(INSTANCE).table(table);
}

function Member(row: ValueProxy<Doc>): ValueProxy<string> {
  return row.key("o").key("é");
}

/** The keys of `{_id}` merged with `{a"b, b}`, then with `{b, c}`, each merge in its own stage. */
async function KeysAfterMerges(): Promise<string[] | undefined> {
  const [keys] = await Table("bare")
    .orderBy("_id")
    .pluck("_id")
    .map((row) => row.merge({ 'a"b': "1", b: "2" }))
    .map((row) => row.merge({ b: "9", c: "3" }).keys())
    .run();
  return keys;
}

/**
 * The values `o` and `p` hold after an update merges `{k: "1"}` into `o`, stored by raw SQL as
 * `{"\\u00e9": "g"}`, and merges `o` into `p`, stored as `{"é": "x"}`.
 */
async function MergedEscaped(): Promise<(string[] | undefined)[]> {
  await Table("bare").insert({ _id: "single" }).run();
  await Run(
    sql`UPDATE ${ident(PhysicalTable(SCHEMA_ID, "bare"))} SET ${ident("_extra")} = ${param('{"o": {"\\u00e9": "g"}, "p": {"é": "x"}}')} WHERE ${ident("_id")} = 'single'`,
  );
  await Table("bare")
    .get("single")
    .update((row) => ({
      o: row.key("o").merge({ k: "1" }),
      p: row.key("p").merge(row.key("o")),
    }))
    .run();
  const [doc] = await Table("bare")
    .getAll("single")
    .map((row) => ({ o: row.key("o").values(), p: row.key("p").values() }))
    .run();
  return [doc?.o.sort(), doc?.p];
}

async function Ids(rows: Promise<Doc[]>): Promise<string[]> {
  return (await rows).map((row) => row._id).sort();
}

async function Filter(
  table: TableId,
): Promise<Record<keyof Filtered, string[]>> {
  const where = (condition: (row: ValueProxy<Doc>) => ValueProxy<boolean>) =>
    Ids(Table(table).filter(condition).run());
  return {
    equalsX: await where((row) => Member(row).eq("x")),
    equalsG: await where((row) => Member(row).eq("g")),
    notEqualsG: await where((row) => Member(row).eq("g").not()),
    unequalG: await where((row) => Member(row).ne("g")),
  };
}

async function Joined(): Promise<Record<"g" | "x", string[]>> {
  const pairs = await schema
    .instance(INSTANCE)
    .table("side")
    .joinInner(
      Table("bare"),
      (side, row) => Member(row).eq(side.key("v")),
      (side, row) => ({ v: side.key("v"), id: row.key("_id") }),
    )
    .run();
  const matched = (value: string) =>
    pairs
      .filter((pair) => pair.v === value)
      .map((pair) => pair.id)
      .sort();
  return { g: matched("g"), x: matched("x") };
}

describe("an object that names one key twice", function () {
  this.timeout(60_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await schema
      .instance(INSTANCE)
      .table("side")
      .insert([
        { _id: "g", v: "g" },
        { _id: "x", v: "x" },
      ])
      .run();
    for (const table of TABLES) {
      await Table(table)
        .insert(IDS.map((_id) => ({ _id })))
        .run();
      for (const id of IDS) {
        await Run(
          sql`UPDATE ${ident(PhysicalTable(SCHEMA_ID, table))} SET ${ident("_extra")} = ${param(STORED[id])} WHERE ${ident("_id")} = ${param(id)}`,
        );
      }
    }
    await WaitForIndexes(SCHEMA_ID);
  });

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  it("reads the last member as the whole document", async () => {
    const rows = await Table("bare").orderBy("_id").run();
    const objects = await Table("bare")
      .orderBy("_id")
      .map((row) => row.key("o"))
      .run();
    expect([rows.map((row) => row.o), objects]).to.deep.equal([
      IDS.map(() => ({ é: "g" })),
      IDS.map(() => ({ é: "g" })),
    ]);
  });

  it("reads each member as docs/mariadb-repeated-keys.md states", async () => {
    const expected =
      GetDialect().id === "mariadb" ? EXPECTED.mariadb : EXPECTED.mysql;
    const rows = await Table("bare")
      .orderBy("_id")
      .map((row) => ({
        id: row.key("_id"),
        member: Member(row),
        merged: row.key("o").merge({ k: "1" }).key("é"),
        keys: row.key("o").keys(),
        values: row.key("o").values(),
      }))
      .run();
    const byId = <T>(read: (row: (typeof rows)[number]) => T) =>
      Object.fromEntries(rows.map((row) => [row.id, read(row)]));
    expect({
      member: byId((row) => row.member),
      merged: byId((row) => row.merged),
      keys: byId((row) => row.keys),
      values: rows.map((row) => row.values),
      indexedG: await Ids(Table("indexed").getAll("g", "o").run()),
      filtered: {
        bare: await Filter("bare"),
        indexed: await Filter("indexed"),
      },
      joined: await Joined(),
      equalsObject: await Ids(
        Table("bare")
          .filter((row) => row.key("o").eq({ é: "g" }))
          .run(),
      ),
      distinctObjects: (
        await Table("bare")
          .map((row) => row.key("o"))
          .distinct()
          .run()
      ).length,
    }).to.deep.equal({ ...expected, values: IDS.map(() => expected.values) });
  });

  it("pairs whole objects by their text on MariaDB 11.8 and as MySQL does on 12.3", async () => {
    const [version] = await Read(sql`SELECT VERSION() AS v`);
    const pairs = await Table("bare")
      .joinInner(
        Table("bare"),
        (left, right) => left.key("o").eq(right.key("o")),
        (left, right) => ({ left: left.key("_id"), right: right.key("_id") }),
      )
      .run();
    const groups = await Table("bare")
      .group("o", (stream) => stream.count())
      .run();
    const sameTextOnly = String(version?.get("v")).startsWith("11.8.");
    expect({ pairs: pairs.length, groups: groups.length }).to.deep.equal({
      pairs: sameTextOnly ? IDS.length : IDS.length * IDS.length,
      groups: GetDialect().id === "mariadb" ? IDS.length : 1,
    });
  });

  it("keeps the left's keys first where a merged object repeats no key", async function () {
    if (GetDialect().id !== "mariadb") {
      this.skip();
    }
    expect(await KeysAfterMerges()).to.deep.equal(["_id", 'a"b', "b", "c"]);
  });

  it("writes back the last member, once, where an update merges the object", async () => {
    await Table("bare")
      .update((row) => ({ o: row.key("o").merge({ k: "1" }) }))
      .run();
    const rows = await Table("bare")
      .orderBy("_id")
      .map((row) => row.key("o").values())
      .run();
    expect(rows.map((values) => [...values].sort())).to.deep.equal(
      IDS.map(() => ["1", "g"]),
    );
  });

  it("keeps the value of a key spelled escaped where an update merges the object", async () => {
    expect(await MergedEscaped()).to.deep.equal([["1", "g"], ["g"]]);
  });
});
