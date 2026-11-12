import { expect } from "chai";
import type { ValueProxy } from "@antelopejs/interface-database";
import { Schema } from "@antelopejs/interface-database/schema";

import { Read, type Row } from "../connection";
import { ident, sql } from "../statement";
import { WaitForIndexes } from "../implementations/database/schema";
import { Compiled } from "./compiled";
import { PhysicalTable, Run } from "./tables";

const SCHEMA_ID = "join_plan";
const INSTANCE = "one";
const OTHER_INSTANCE = "two";
const BOOKS = 3000;
const REVIEWS = 20;
const STRIDE = 7;
const UNMATCHED = "titre none";

interface Book {
  _id: string;
  title: { fr?: string; en: string };
}

interface Review {
  _id: string;
  bookTitle: string;
  bookId: string;
}

const BOOK_FIELDS = { title: "object" } as const;

const schema = new Schema<{
  indexed: Book;
  bare: Book;
  reviews: Review;
}>(SCHEMA_ID, {
  indexed: {
    fields: BOOK_FIELDS,
    indexes: { titleFr: { fields: ["title.fr"] } },
  },
  bare: { fields: BOOK_FIELDS, indexes: {} },
  reviews: {
    fields: { bookTitle: "string", bookId: "string" },
    indexes: {},
  },
});

/** Every book has a French title but `b-1`, which only the English fallback names. */
const BOOK_ROWS: Book[] = Array.from({ length: BOOKS }, (_, n) => ({
  _id: `b-${n}`,
  title:
    n === 1 ? { en: `title ${n}` } : { fr: `titre ${n}`, en: `title ${n}` },
}));

/** Reviews of every seventh book, then one that names the fallback of `b-1` and one that names no book. */
const REVIEW_ROWS: Review[] = [
  ...Array.from({ length: REVIEWS - 2 }, (_, k) => ({
    _id: `r-${String(k).padStart(2, "0")}`,
    bookTitle: `titre ${(k + 1) * STRIDE}`,
    bookId: `b-${(k + 1) * STRIDE}`,
  })),
  { _id: "r-fallback", bookTitle: "title 1", bookId: "b-1" },
  { _id: "r-unmatched", bookTitle: UNMATCHED, bookId: "b-none" },
];

type BookTable = "indexed" | "bare";
type Condition = (
  review: ValueProxy<Review>,
  book: ValueProxy<Book>,
) => ValueProxy<boolean>;

const CONDITIONS = {
  title: (review, book) =>
    book.key("title").key("fr").eq(review.key("bookTitle")),
  fallback: (review, book) =>
    book
      .key("title")
      .key("fr")
      .default(book.key("title").key("en"))
      .eq(review.key("bookTitle")),
  id: (review, book) => book.key("_id").eq(review.key("bookId")),
} satisfies Record<string, Condition>;

function Table<Name extends BookTable | "reviews">(
  name: Name,
  instance = INSTANCE,
) {
  return schema.instance(instance).table(name);
}

function Joined(table: BookTable, condition: Condition) {
  return Table("reviews")
    .slice(0, REVIEWS)
    .joinInner(Table(table), condition, (review, book) => ({
      review: review.key("_id"),
      book: book.key("_id"),
    }));
}

/** A join that reads the inner table once for a buffer of outer rows, as each engine spells it. */
const BUFFERED_JOIN = /hash join|BNL join/;

function Text(row: Row, column: string): string {
  return String(row.get(column));
}

/**
 * How the plan reads the books: its access type and index, and whether it reads them once for many
 * reviews, through MySQL's hash join or MariaDB's join buffer.
 */
async function BooksAccess(
  table: BookTable,
  condition: Condition,
): Promise<string> {
  const plan = await Read(
    sql`EXPLAIN FORMAT=TRADITIONAL ${Compiled(Joined(table, condition))}`,
  );
  const books = plan.filter(
    (row) =>
      Text(row, "select_type") === "PRIMARY" &&
      !Text(row, "table").startsWith("<"),
  );
  expect(books, "one plan row reads the books").to.have.length(1);
  const [row] = books;
  const buffered = BUFFERED_JOIN.test(Text(row, "Extra")) ? " buffered" : "";
  return `${Text(row, "type")} ${Text(row, "key")}${buffered}`;
}

async function Pairs(
  table: BookTable,
  condition: Condition,
): Promise<string[]> {
  const pairs = await Joined(table, condition).run();
  return pairs.map(({ review, book }) => `${review} ${book}`).sort();
}

const EXPECTED = REVIEW_ROWS.slice(0, REVIEWS - 2).map(
  (review) => `${review._id} ${review.bookId}`,
);

describe("a join against a table read whole", function () {
  this.timeout(120_000);

  before(async () => {
    for (const instance of [INSTANCE, OTHER_INSTANCE]) {
      await schema.createInstance(instance).run();
      await Table("indexed", instance).insert(BOOK_ROWS).run();
      await Table("bare", instance).insert(BOOK_ROWS).run();
    }
    await Table("reviews").insert(REVIEW_ROWS).run();
    await WaitForIndexes(SCHEMA_ID);
    for (const table of ["indexed", "bare", "reviews"]) {
      await Run(sql`ANALYZE TABLE ${ident(PhysicalTable(SCHEMA_ID, table))}`);
    }
  });

  it("reads the books once and joins them through a buffer where no index serves the condition", async () => {
    expect(await BooksAccess("bare", CONDITIONS.title)).to.match(/ buffered$/);
    expect(await Pairs("bare", CONDITIONS.title)).to.deep.equal(EXPECTED);
  });

  it("looks each review's book up through the key column an index declares", async () => {
    expect(await BooksAccess("indexed", CONDITIONS.title)).to.equal(
      "ref titleFr",
    );
    expect(await Pairs("indexed", CONDITIONS.title)).to.deep.equal(EXPECTED);
  });

  it("looks a book up through that key column where the read falls back to a default", async () => {
    expect(await BooksAccess("indexed", CONDITIONS.fallback)).to.equal(
      "ref_or_null titleFr",
    );
    expect(await Pairs("indexed", CONDITIONS.fallback)).to.deep.equal(
      [...EXPECTED, "r-fallback b-1"].sort(),
    );
  });

  it("looks a book up by its primary key where the condition reads `_id`", async () => {
    for (const table of ["indexed", "bare"] as const) {
      expect(await BooksAccess(table, CONDITIONS.id), table).to.equal(
        "eq_ref PRIMARY",
      );
      expect(await Pairs(table, CONDITIONS.id), table).to.deep.equal(
        [...EXPECTED, "r-fallback b-1"].sort(),
      );
    }
  });

  it("keeps a review no book matches in an outer join, and reads only the review's instance", async () => {
    const joined = await Table("reviews")
      .join(Table("bare"), CONDITIONS.title, (review, book) => ({
        review: review.key("_id"),
        book: book.key("_id"),
      }))
      .run();
    const pairs = joined
      .map(({ review, book }) => `${review} ${String(book)}`)
      .sort();
    expect(pairs).to.deep.equal(
      [...EXPECTED, "r-fallback null", "r-unmatched null"].sort(),
    );
  });
});
