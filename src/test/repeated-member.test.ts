import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

import { GetDialect } from "../connection";
import { ident, param, sql } from "../statement";
import { WaitForIndexes } from "../implementations/database/schema";
import { PhysicalTable, Run } from "./tables";

const SCHEMA_ID = "repeated_member";
const INSTANCE = "one";

interface Doc {
  _id: string;
  o?: Record<string, string>;
}

const schema = new Schema<{ bare: Doc; indexed: Doc }>(SCHEMA_ID, {
  bare: { fields: {}, indexes: {} },
  indexed: { fields: {}, indexes: { o: { fields: ["o.é"] } } },
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
}

interface Reads {
  member: Record<Id, string>;
  keys: Record<Id, string[]>;
  values: string[];
  indexedG: Id[];
  filtered: Record<TableId, Filtered>;
}

const LAST: Filtered = { equalsX: [], equalsG: IDS, notEqualsG: [] };

/** What each read answers, as `docs/mariadb.md` states it. */
const EXPECTED: Readonly<Record<"mysql" | "mariadb", Reads>> = {
  mysql: {
    member: { plain: "g", escapedFirst: "g", escapedLast: "g" },
    keys: { plain: ["é"], escapedFirst: ["é"], escapedLast: ["é"] },
    values: ["g"],
    indexedG: IDS,
    filtered: { bare: LAST, indexed: LAST },
  },
  mariadb: {
    member: { plain: "x", escapedFirst: "g", escapedLast: "x" },
    keys: { plain: ["é"], escapedFirst: ["é", "é"], escapedLast: ["é", "é"] },
    values: ["x", "g"],
    indexedG: ["escapedFirst"],
    filtered: {
      bare: {
        equalsX: ["escapedLast", "plain"],
        equalsG: [],
        notEqualsG: IDS,
      },
      indexed: {
        equalsX: ["escapedLast", "plain"],
        equalsG: ["escapedFirst"],
        notEqualsG: ["escapedLast", "plain"],
      },
    },
  },
};

function Table(table: TableId) {
  return schema.instance(INSTANCE).table(table);
}

async function Ids(rows: Promise<Doc[]>): Promise<string[]> {
  return (await rows).map((row) => row._id).sort();
}

async function Filter(table: TableId): Promise<Record<string, string[]>> {
  return {
    equalsX: await Ids(
      Table(table)
        .filter((row) => row.key("o").key("é").eq("x"))
        .run(),
    ),
    equalsG: await Ids(
      Table(table)
        .filter((row) => row.key("o").key("é").eq("g"))
        .run(),
    ),
    notEqualsG: await Ids(
      Table(table)
        .filter((row) => row.key("o").key("é").eq("g").not())
        .run(),
    ),
  };
}

describe("an object that names one key twice", function () {
  this.timeout(60_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
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
    expect(rows.map((row) => row.o)).to.deep.equal(IDS.map(() => ({ é: "g" })));
  });

  it("reads each member as docs/mariadb.md states", async () => {
    const expected =
      GetDialect().id === "mariadb" ? EXPECTED.mariadb : EXPECTED.mysql;
    const rows = await Table("bare")
      .orderBy("_id")
      .map((row) => ({
        id: row.key("_id"),
        member: row.key("o").key("é"),
        keys: row.key("o").keys(),
        values: row.key("o").values(),
      }))
      .run();
    expect({
      member: Object.fromEntries(rows.map((row) => [row.id, row.member])),
      keys: Object.fromEntries(rows.map((row) => [row.id, row.keys])),
      values: rows.map((row) => row.values),
      indexedG: await Ids(Table("indexed").getAll("g", "o").run()),
      filtered: {
        bare: await Filter("bare"),
        indexed: await Filter("indexed"),
      },
    }).to.deep.equal({ ...expected, values: IDS.map(() => expected.values) });
  });
});
