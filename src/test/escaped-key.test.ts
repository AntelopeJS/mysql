import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";
import { ValueProxy } from "@antelopejs/interface-database";

import { GetDialect } from "../connection";
import { ident, param, sql } from "../statement";
import { WaitForIndexes } from "../implementations/database/schema";
import { PhysicalTable, Run } from "./tables";

const SCHEMA_ID = "escaped_key";
const INSTANCE = "one";
/** A key holding a vertical tab, which MariaDB's `JSON_OBJECT` writes as an uppercase hex escape. */
const CONTROL_KEY = `a${String.fromCharCode(11)}b`;
/** Keys a `default()` separates, so each read reads the one before it rather than one path. */
const CHAIN_KEYS = Array.from({ length: 8 }, (_, depth) => `k${depth}é`);
/** Top-level keys each naming the next, so each read's key is the read before it. */
const HOPS = Array.from({ length: 9 }, (_, depth) => `p${depth}é`);
const HEX = 16;
const HEX_DIGITS = 4;

interface Labels {
  CAFÉ?: string;
  café?: string;
  "a/b"?: string;
  "<b>"?: string;
  fr?: string;
  en?: string;
}

interface Nested {
  [key: string]: Nested | string;
}

interface Doc {
  _id: string;
  café?: string;
  pick?: "code";
  start?: string;
  chain?: Nested;
  été?: Labels;
  code?: string;
  lang: keyof Labels;
}

const schema = new Schema<{ bare: Doc; keyed: Doc }>(SCHEMA_ID, {
  bare: { fields: {}, indexes: {} },
  keyed: { fields: {}, indexes: { cafe: { fields: ["été.café"] } } },
});

type TableId = "bare" | "keyed";

const TABLES: readonly TableId[] = ["bare", "keyed"];

/** `key` as JSON text spells it where its writer escapes each of `chars` by its code unit. */
function Spelled(key: string, chars: string): string {
  return Array.from(key, (char) =>
    chars.includes(char)
      ? `\\u${char.charCodeAt(0).toString(HEX).padStart(HEX_DIGITS, "0")}`
      : char,
  ).join("");
}

/**
 * Keys as PHP, Python, Go and .NET writers spell them: a non-ASCII character, `<` and `/` escaped.
 * `CAFÉ` comes before `café`, so a key search that ignores case finds it. `fr` and `code` are
 * spelled with an escaped ASCII letter, which no common writer does: MariaDB reads `fr`, under a
 * key a writer escapes, and leaves `code`, a path of plain keys only, unread; MySQL reads both.
 */
const CHAIN = CHAIN_KEYS.reduceRight(
  (inner, key) => `{"${Spelled(key, "é")}": ${inner}}`,
  '"v"',
);

const HOPPED = HOPS.slice(0, -1)
  .map((key, depth) => `"${Spelled(key, "é")}": "${HOPS[depth + 1]}"`)
  .join(", ");

const ESCAPED = param(
  JSON.stringify({ lang: "café" }).replace(
    "{",
    `{"${Spelled("été", "é")}": {"${Spelled("CAFÉ", "É")}": "x", "${Spelled("café", "é")}": "h", "a\\/b": "j", "${Spelled("<b>", "<")}": "k", "${Spelled("fr", "r")}": "p", "en": "i"}, "${Spelled("code", "o")}": "z", "chain": ${CHAIN}, "${Spelled("café", "é")}": "t", "pick": "code", "start": "${HOPS[0]}", ${HOPPED}, `,
  ),
);

const DOCS: Doc[] = [
  { _id: "escaped", lang: "café" },
  { _id: "plain", été: { café: "a", en: "b" }, lang: "café" },
];

function Table(table: TableId) {
  return schema.instance(INSTANCE).table(table);
}

function Labels(row: ValueProxy<Doc>): ValueProxy<Labels | undefined> {
  return row.key("été");
}

async function Ids(
  table: TableId,
  condition: (row: ValueProxy<Doc>) => ValueProxy<boolean>,
): Promise<string[]> {
  const rows = await Table(table).filter(condition).run();
  return rows.map((row) => row._id).sort();
}

/** Reads, on each table, members under keys the statement computes, and filters by one. */
async function ExpectComputedKeys(): Promise<void> {
  for (const table of TABLES) {
    const rows = await Table(table)
      .map((row) => ({
        id: row.key("_id"),
        computed: row.key(row.key("lang").cast<"café">()),
        held: Labels(row).key(row.key("lang")),
        plain: row.key(row.key("pick").cast<"code">()),
        hopped: HOPS.slice(0, -1).reduce(
          (key) => row.key(key.cast<keyof Doc>()).cast<string>(),
          row.key("start").default("").cast<string>(),
        ),
      }))
      .run();
    expect(
      Object.fromEntries(rows.map(({ id, ...read }) => [id, read])),
      table,
    ).to.deep.equal({
      escaped: {
        computed: "t",
        held: "h",
        plain: GetDialect().id === "mariadb" ? null : "z",
        hopped: HOPS.at(-1),
      },
      plain: { computed: null, held: "a", plain: null, hopped: null },
    });
    const projected = await Table(table)
      .map((row) => Labels(row))
      .map((labels) => labels.key(ValueProxy.constant<"café">("café")))
      .run();
    expect(projected, table).to.have.members(["a", "h"]);
    expect(
      await Ids(table, (row) =>
        row.key(row.key("lang").cast<"café">()).eq("t"),
      ),
      table,
    ).to.deep.equal(["escaped"]);
  }
}

describe("a member whose key is stored escaped", function () {
  this.timeout(60_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    for (const table of TABLES) {
      await Table(table).insert(DOCS).run();
      await Run(
        sql`UPDATE ${ident(PhysicalTable(SCHEMA_ID, table))} SET ${ident("_extra")} = ${ESCAPED} WHERE ${ident("_id")} = 'escaped'`,
      );
    }
    await WaitForIndexes(SCHEMA_ID);
  });

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  it("reads as the key it spells, a plain ASCII key excepted", async () => {
    for (const table of TABLES) {
      const rows = await Table(table)
        .map((row) => ({
          id: row.key("_id"),
          cafe: Labels(row).key("café"),
          slash: Labels(row).key("a/b"),
          angle: Labels(row).key("<b>"),
          en: Labels(row).key("en"),
          localized: Labels(row).key("café").default(Labels(row).key("en")),
          fr: Labels(row).key("fr"),
          code: row.key("code"),
        }))
        .run();
      const escaped = rows.find((row) => row.id === "escaped");
      expect(escaped, table).to.deep.equal({
        id: "escaped",
        cafe: "h",
        slash: "j",
        angle: "k",
        en: "i",
        localized: "h",
        fr: "p",
        code: GetDialect().id === "mariadb" ? null : "z",
      });
    }
  });

  it(
    "reads a key the statement computes as the key it spells, a plain ASCII key excepted",
    ExpectComputedKeys,
  );

  it("filters as the key it spells", async () => {
    for (const table of TABLES) {
      expect(
        await Ids(table, (row) => Labels(row).key("café").eq("h")),
        table,
      ).to.deep.equal(["escaped"]);
      expect(
        await Ids(table, (row) => Labels(row).hasfields("café")),
        table,
      ).to.deep.equal(["escaped", "plain"]);
    }
  });

  it("is found by an index on the key it spells", async () => {
    const rows = await Table("keyed").getAll("h", "cafe").run();
    expect(rows.map((row) => row._id)).to.deep.equal(["escaped"]);
  });

  it("reads a chain of keys a default() separates, each document spelled once", async () => {
    const rows = await Table("bare")
      .map((row) => ({
        id: row.key("_id"),
        end: CHAIN_KEYS.reduce(
          (value, key) => value.key(key).default({}).cast<Nested>(),
          row.key("chain").default({}).cast<Nested>(),
        ),
      }))
      .run();
    expect(rows.find((row) => row.id === "escaped")?.end).to.equal("v");
  });

  it("reads on MariaDB a key holding a control character, which merge() stores escaped", async function () {
    if (GetDialect().id !== "mariadb") {
      this.skip();
    }
    const rows = await Table("bare")
      .map((row) => ({
        merged: Labels(row)
          .default({})
          .merge({ [CONTROL_KEY]: "v" })
          .key(CONTROL_KEY),
      }))
      .run();
    expect(rows.map((row) => row.merged)).to.deep.equal(["v", "v"]);
  });
});
