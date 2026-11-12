import { expect } from "chai";
import type { ValueProxy } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";

import { Read, type Row } from "../connection";
import { ident, sql } from "../statement";
import { WaitForIndexes } from "../implementations/database/schema";
import { Compiled } from "./compiled";
import { PhysicalTable, Run } from "./tables";

const SCHEMA_ID = "defaulted_key";
const INSTANCE = "one";
const ROWS = 2000;

/** A title in two locales, whose French text a few rows leave absent, null or a number. */
interface Title {
  fr?: string | number | null;
  en: string;
}

interface Book {
  _id: string;
  title: Title;
  _internal: { data: { title: Title } };
}

const schema = new Schema<{ books: Book }>(SCHEMA_ID, {
  books: {
    fields: { title: "object" },
    indexes: {
      titleFr: { fields: ["title.fr"] },
      headingFr: { fields: ["_internal.data.title.fr"] },
    },
  },
});

/**
 * Every row has an English title; the French one is a string, except on the rows a fallback is
 * tested on: absent on `b-1`, a JSON null on `b-2`, and a number on `b-3`.
 */
function TitleOf(n: number): Title {
  const en = `title ${n}`;
  switch (n) {
    case 1:
      return { en };
    case 2:
      return { fr: null, en };
    case 3:
      return { fr: 3, en };
    default:
      return { fr: `titre ${n}`, en };
  }
}

const BOOKS: Book[] = Array.from({ length: ROWS }, (_, n) => ({
  _id: `b-${n}`,
  title: TitleOf(n),
  _internal: { data: { title: TitleOf(n) } },
}));

function Books() {
  return schema.instance(INSTANCE).table("books");
}

type Reading = (row: ValueProxy<Book>) => ValueProxy<string | number>;

/** The French title, falling back to the English one, as the decorators' `@Localized` reads it. */
const READINGS = {
  titleFr: (row) =>
    row.key("title").key("fr").default(row.key("title").key("en")),
  headingFr: (row) => {
    const title = row.key("_internal").key("data").key("title");
    return title.key("fr").default(title.key("en"));
  },
} satisfies Record<string, Reading>;

function Matching(reading: Reading, value: string) {
  return Books().filter((row) => reading(row).eq(value));
}

function Text(row: Row, column: string): string {
  return String(row.get(column));
}

/** The access type and index the server's plan reads the books with. */
async function Access(reading: Reading): Promise<string> {
  const [plan] = await Read(
    sql`EXPLAIN FORMAT=TRADITIONAL ${Compiled(Matching(reading, "titre 7"))}`,
  );
  return `${Text(plan, "type")} ${Text(plan, "key")}`;
}

async function Ids(reading: Reading, value: string): Promise<string[]> {
  const books = await Matching(reading, value).run();
  return books.map((book) => book._id).sort();
}

describe("an equality on a read that falls back to a default", function () {
  this.timeout(60_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Books().insert(BOOKS).run();
    await WaitForIndexes(SCHEMA_ID);
    await Run(sql`ANALYZE TABLE ${ident(PhysicalTable(SCHEMA_ID, "books"))}`);
  });

  for (const [index, reading] of Object.entries(READINGS)) {
    it(`is served by the index over the read it falls back from (${index})`, async () => {
      expect(await Access(reading)).to.equal(`ref_or_null ${index}`);
    });

    it(`finds a row by its read, or by its default where the read is absent or null (${index})`, async () => {
      expect(await Ids(reading, "titre 7")).to.deep.equal(["b-7"]);
      expect(await Ids(reading, "title 1")).to.deep.equal(["b-1"]);
      expect(await Ids(reading, "title 2")).to.deep.equal(["b-2"]);
      expect(await Ids(reading, "title 7")).to.deep.equal([]);
      expect(await Ids(reading, "title 3")).to.deep.equal([]);
      expect(await Ids(reading, "3")).to.deep.equal([]);
    });
  }
});
