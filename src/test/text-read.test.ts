import { expect } from "chai";
import type { ValueProxy } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";

import { ident, param, sql } from "../statement";
import { PhysicalTable, Run } from "./tables";

const SCHEMA_ID = "text_read";
const INSTANCE = "one";
const ESCAPED = 'été "cité" \\ fin';
const LONG = `${"x".repeat(600)}7`;
/**
 * `keyed` as another writer may store it, its keys `fr` and `café` escaped. MariaDB's `JSON_VALUE`
 * decodes `"f\u0072"`, which its member read leaves unread, and both read `"caf\u00e9"`.
 */
const ESCAPED_KEY_EXTRA = param(
  '{"keyed": {"f\\u0072": "h", "en": "i", "caf\\u00e9": "j"}}',
);

/** A document with no declared field, whose `v` holds a value of each kind, and a title in two locales. */
interface Doc {
  _id: string;
  v?: unknown;
  title?: { fr?: unknown; en: string };
  keyed?: Record<string, string>;
}

const DOCS: Doc[] = [
  { _id: "v-string", v: "7" },
  { _id: "v-number", v: 7 },
  { _id: "v-eight", v: 8 },
  { _id: "v-null", v: null },
  { _id: "v-absent" },
  { _id: "v-array", v: ["7"] },
  { _id: "v-object", v: { x: "7" } },
  { _id: "v-escaped", v: ESCAPED },
  { _id: "v-long", v: LONG },
  { _id: "v-other", v: "8" },
  { _id: "t-fr", title: { fr: "a", en: "b" } },
  { _id: "t-null", title: { fr: null, en: "c" } },
  { _id: "t-absent", title: { en: "d" } },
  { _id: "t-number", title: { fr: 5, en: "e" } },
  { _id: "t-object", title: { fr: { x: 1 }, en: "f" } },
  { _id: "t-string-null", title: { fr: "null", en: "g" } },
  { _id: "k-escaped", keyed: { fr: "h", en: "i" } },
];

/** A book whose `title` is a declared object of strings, so `title.fr` is read as text where it is read. */
interface Book {
  _id: string;
  title: { fr?: string; en: string };
}

const BOOKS: Book[] = [
  { _id: "b-fr", title: { fr: "a", en: "b" } },
  { _id: "b-absent", title: { en: "c" } },
  { _id: "b-number", title: { fr: "5", en: "d" } },
];

/** `b-number`'s title as another writer may store it, with a number where the schema declares a string. */
const NUMBER_TITLE = param('{"fr": 5, "en": "d"}');

const schema = new Schema<{ docs: Doc; books: Book }>(SCHEMA_ID, {
  docs: { fields: {}, indexes: {} },
  books: { fields: { title: { fr: "string", en: "string" } }, indexes: {} },
});

function Docs() {
  return schema.instance(INSTANCE).table("docs");
}

type Condition = (row: ValueProxy<Doc>) => ValueProxy<boolean>;

function Books() {
  return schema.instance(INSTANCE).table("books");
}

type BookCondition = (row: ValueProxy<Book>) => ValueProxy<boolean>;

async function BookIds(condition: BookCondition): Promise<string[]> {
  const books = await Books().filter(condition).run();
  return books.map((book) => book._id).sort();
}

async function Ids(condition: Condition): Promise<string[]> {
  const docs = await Docs().filter(condition).run();
  return docs.map((doc) => doc._id).sort();
}

function Value(row: ValueProxy<Doc>): ValueProxy<unknown> {
  return row.key("v");
}

function Localized(row: ValueProxy<Doc>): ValueProxy<unknown> {
  const title = row.key("title");
  return title.key("fr").default(title.key("en"));
}

function Keyed(row: ValueProxy<Doc>, key = "fr") {
  const keyed = row.key("keyed");
  return keyed.key(key).default(keyed.key("en"));
}

/** Conditions whose filter must keep the rows their projection is true on, on every engine. */
const AGREEING = {
  "v = 7": (row) => Value(row).eq("7"),
  "v > 6": (row) => Value(row).gt("6"),
  "localized = g": (row) => Localized(row).eq("g"),
  "localized = null": (row) => Localized(row).eq("null"),
  "localized <= g": (row) => Localized(row).le("g"),
  "escaped key = h": (row) => Keyed(row).eq("h"),
  "escaped key = i": (row) => Keyed(row).eq("i"),
  "escaped accented key = j": (row) => row.key("keyed").key("café").eq("j"),
  "escaped accented key or default = j": (row) => Keyed(row, "café").eq("j"),
} satisfies Record<string, Condition>;

describe("a comparison of a JSON read with a string, unindexed", function () {
  this.timeout(60_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Docs().insert(DOCS).run();
    await Run(
      sql`UPDATE ${ident(PhysicalTable(SCHEMA_ID, "docs"))} SET ${ident("_extra")} = ${ESCAPED_KEY_EXTRA} WHERE ${ident("_id")} = 'k-escaped'`,
    );
    await Books().insert(BOOKS).run();
    await Run(
      sql`UPDATE ${ident(PhysicalTable(SCHEMA_ID, "books"))} SET ${ident("title")} = ${NUMBER_TITLE} WHERE ${ident("_id")} = 'b-number'`,
    );
  });

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  it("matches a JSON string by its text, and no value of another kind spelled the same", async () => {
    expect(await Ids((row) => Value(row).eq("7"))).to.deep.equal(["v-string"]);
  });

  it("matches a string that is stored escaped, and one longer than 512 characters", async () => {
    expect(await Ids((row) => Value(row).eq(ESCAPED))).to.deep.equal([
      "v-escaped",
    ]);
    expect(await Ids((row) => Value(row).eq(LONG))).to.deep.equal(["v-long"]);
  });

  it("orders strings only", async () => {
    expect(await Ids((row) => Value(row).gt("6"))).to.deep.equal([
      "v-escaped",
      "v-long",
      "v-other",
      "v-string",
    ]);
  });

  it("keeps under not every row the equality is not true of, a value of another kind and an absent one included", async () => {
    const kept = await Ids((row) => Value(row).eq("7").not());
    expect(kept).to.include.members(["v-number", "v-absent", "v-array"]);
    expect(kept).to.have.length(DOCS.length - 1);
  });

  it("keeps a row under or where either side is true, and under and where both are", async () => {
    expect(
      await Ids((row) => Value(row).eq("7").or(Value(row).eq("8"))),
    ).to.deep.equal(["v-other", "v-string"]);
    expect(
      await Ids((row) => Value(row).eq("7").and(row.key("_id").eq("v-string"))),
    ).to.deep.equal(["v-string"]);
  });

  it("projects the equality itself, unknown where the read is of another kind or absent", async () => {
    const rows = await Docs()
      .map((row) => ({ id: row.key("_id"), same: Value(row).eq("7") }))
      .run();
    const same = new Map(rows.map((row) => [row.id, row.same]));
    const shown = ["v-string", "v-number", "v-eight", "v-absent", "v-other"];
    expect(
      Object.fromEntries(shown.map((id) => [id, same.get(id)])),
    ).to.deep.equal({
      "v-string": true,
      "v-number": null,
      "v-eight": null,
      "v-absent": null,
      "v-other": false,
    });
  });

  for (const [name, condition] of Object.entries(AGREEING)) {
    it(`keeps in a filter exactly the rows its projection is true on (${name})`, async () => {
      const projected = await Docs()
        .map((row) => ({ id: row.key("_id"), holds: condition(row) }))
        .run();
      const expected = projected
        .filter((row) => row.holds === true)
        .map((row) => row.id)
        .sort();
      expect(await Ids(condition)).to.deep.equal(expected);
    });
  }

  it("matches a declared string member by its text, and no number stored under it", async () => {
    const French = (row: ValueProxy<Book>) => row.key("title").key("fr");
    expect(await BookIds((row) => French(row).eq("a"))).to.deep.equal(["b-fr"]);
    expect(await BookIds((row) => French(row).eq("5"))).to.deep.equal([]);
    expect(await BookIds((row) => French(row).ge("0"))).to.deep.equal(["b-fr"]);
  });

  it("matches an accented key stored escaped, as every engine reads it", async () => {
    expect(
      await Ids((row) => row.key("keyed").key("café").eq("j")),
    ).to.deep.equal(["k-escaped"]);
    expect(await Ids((row) => Keyed(row, "café").eq("j"))).to.deep.equal([
      "k-escaped",
    ]);
  });

  it("matches a default where the read is absent or a JSON null, and nowhere the read is of another kind", async () => {
    expect(await Ids((row) => Localized(row).eq("a"))).to.deep.equal(["t-fr"]);
    expect(await Ids((row) => Localized(row).eq("b"))).to.deep.equal([]);
    expect(await Ids((row) => Localized(row).eq("c"))).to.deep.equal([
      "t-null",
    ]);
    expect(await Ids((row) => Localized(row).eq("d"))).to.deep.equal([
      "t-absent",
    ]);
    expect(await Ids((row) => Localized(row).eq("e"))).to.deep.equal([]);
    expect(await Ids((row) => Localized(row).eq("5"))).to.deep.equal([]);
    expect(await Ids((row) => Localized(row).eq("f"))).to.deep.equal([]);
  });
});
