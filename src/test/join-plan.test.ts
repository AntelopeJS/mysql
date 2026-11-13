import { expect } from "chai";
import type { Stream, ValueProxy } from "@antelopejs/interface-database";
import { CROSS_INSTANCE, Schema } from "@antelopejs/interface-database/schema";

import { GetDialect, Read, type Row } from "../connection";
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

type UndeclaredKey = string | { a: number; b: number[] } | null;

interface LooseBook {
  _id: string;
  meta: { key?: UndeclaredKey };
}

interface Note {
  _id: string;
  ref?: UndeclaredKey;
}

const BOOK_FIELDS = { title: "object" } as const;

const schema = new Schema<{
  indexed: Book;
  bare: Book;
  reviews: Review;
  loose: LooseBook;
  notes: Note;
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
  loose: { fields: {}, indexes: {} },
  notes: { fields: {}, indexes: {} },
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

/** Two unequal JSON strings whose normalized texts share one CRC-32. */
const COLLIDING_KEYS = ["prhuztsj", "vojecigt"] as const;
const COLLIDING_BOOK = 4;

/**
 * Every book's key is its French title but `b-1`'s, an object, `b-2`'s, a JSON null, `b-3`'s, which
 * is absent, and `b-4`'s, the first of {@link COLLIDING_KEYS}.
 */
function LooseMeta(n: number, title: string | undefined): LooseBook["meta"] {
  if (n === 1) {
    return { key: { a: 1, b: [1, 2] } };
  }
  if (n === 2) {
    return { key: null };
  }
  if (n === 3) {
    return {};
  }
  return { key: n === COLLIDING_BOOK ? COLLIDING_KEYS[0] : title };
}

const LOOSE_ROWS: LooseBook[] = BOOK_ROWS.map(({ _id, title }, n) => ({
  _id,
  meta: LooseMeta(n, title.fr),
}));

/**
 * One naming `b-1`'s object with its keys in another order, one a JSON null, one with no key, one
 * naming no book, and one whose key only shares its hash with `b-4`'s.
 */
const SPECIAL_NOTES: Note[] = [
  { _id: "r-object", ref: { b: [1, 2], a: 1 } },
  { _id: "r-null", ref: null },
  { _id: "r-absent" },
  { _id: "r-unmatched", ref: UNMATCHED },
  { _id: "r-colliding", ref: COLLIDING_KEYS[1] },
];

/** The reviews of every seventh book as notes, then {@link SPECIAL_NOTES}, a page in all. */
const NOTE_ROWS: Note[] = [
  ...REVIEW_ROWS.slice(0, REVIEWS - SPECIAL_NOTES.length).map(
    ({ _id, bookTitle }) => ({ _id, ref: bookTitle }),
  ),
  ...SPECIAL_NOTES,
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

function Table<Name extends BookTable | "reviews" | "loose" | "notes">(
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

/** One plan row's access: its type and index, whether it reads a derived table, and whether through a buffer. */
function Access(row: Row): string {
  const derived = Text(row, "table").startsWith("<derived") ? "derived " : "";
  const buffered = BUFFERED_JOIN.test(Text(row, "Extra")) ? " buffered" : "";
  return `${derived}${Text(row, "type")} ${Text(row, "key")}${buffered}`;
}

/** The first `count` notes, or every note where `count` is absent, which leaves the compiler no bound. */
function Notes(count?: number) {
  return count === undefined
    ? Table("notes")
    : Table("notes").orderBy("_id").slice(0, count);
}

/** The notes whose `field` is the first note's, by a filter. */
function FirstNoteBy(field: "_id" | "ref") {
  return Table("notes").filter((note) =>
    note.key(field).eq(NOTE_ROWS[0][field]),
  );
}

/**
 * Notes the compiler knows are one: a page of one, and the note a filter names by `_id`, alone, in
 * a page, or narrowed by a later filter.
 */
function OneNote() {
  const byId = FirstNoteBy("_id");
  const narrowed = byId.filter((note) => note.key("ref").eq(NOTE_ROWS[0].ref));
  return [Notes(1), byId, byId.slice(0, REVIEWS), narrowed];
}

/**
 * Notes a filter does not bound to one, each beside the pairs it joins: the notes a filter on `ref`
 * names, which can be many, every note an equality of `_id` with itself keeps, the first note in
 * every instance, and the notes a join fans the first note out to.
 */
function Unbound() {
  const id = NOTE_ROWS[0]._id;
  const notes = schema.instance(CROSS_INSTANCE).table("notes");
  const fannedOut = FirstNoteBy("_id").joinInner(
    Table("notes"),
    (_note, other) => other.key("_id").ne(id),
    (_note, other) => other,
  );
  return [
    [FirstNoteBy("ref"), [EXPECTED[0]]],
    [
      Table("notes").filter((note) => note.key("_id").eq(note.key("_id"))),
      LOOSE_EXPECTED,
    ],
    [
      notes.filter((note) => note.key("_id").eq(id)),
      [EXPECTED[0], EXPECTED[0]],
    ],
    [fannedOut, LOOSE_EXPECTED.filter((pair) => pair !== EXPECTED[0])],
  ] as const;
}

/** The notes joined to the books whose key they name. */
function LooseJoined(notes: Stream<Note> = Notes()) {
  return notes.joinInner(
    Table("loose"),
    (note, book) => book.key("meta").key("key").eq(note.key("ref")),
    (note, book) => ({ review: note.key("_id"), book: book.key("_id") }),
  );
}

/**
 * How the plan joins a table to the page of rows it reads first, one access per plan row: whether
 * it reads the table once for many rows, through MySQL's hash join or MariaDB's join buffer, or
 * looks each row's matches up through an index.
 */
async function JoinAccess(
  joined: Parameters<typeof Compiled>[0],
  pageRows?: number,
): Promise<string> {
  const plan = await Read(sql`EXPLAIN FORMAT=TRADITIONAL ${Compiled(joined)}`);
  const [page, ...books] = plan.filter((row) => Text(row, "id") === "1");
  if (pageRows !== undefined) {
    expect(Text(page, "rows"), "the page of reviews is read first").to.equal(
      String(pageRows),
    );
  }
  return books.map(Access).join(", ");
}

function BooksAccess(table: BookTable, condition: Condition): Promise<string> {
  return JoinAccess(Joined(table, condition), REVIEWS);
}

/**
 * The books' access where no index serves the condition. MySQL hash joins the instance's range.
 * MariaDB, whose join buffer would compute the books' side once per pair of rows, computes it once
 * per book into a derived table of identities, joins that through the buffer, and reads each
 * matched book by its primary key.
 */
function UnindexedAccess(): string {
  return GetDialect().id === "mysql"
    ? "range PRIMARY buffered"
    : "derived ALL null buffered, eq_ref PRIMARY";
}

/** The access of books a join hashes, wherever in the plan they are read. */
function HashedAccess(): string {
  return GetDialect().id === "mysql" ? "buffered" : "derived ALL null buffered";
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

const LOOSE_EXPECTED = [
  ...EXPECTED.slice(0, REVIEWS - SPECIAL_NOTES.length),
  "r-object b-1",
  "r-null b-2",
].sort();

async function LoosePairs(notes?: Stream<Note>): Promise<string[]> {
  const pairs = await LooseJoined(notes).run();
  return pairs.map(({ review, book }) => `${review} ${book}`).sort();
}

describe("a join against a table read whole", function () {
  this.timeout(120_000);

  before(async () => {
    for (const instance of [INSTANCE, OTHER_INSTANCE]) {
      await schema.createInstance(instance).run();
      await Table("indexed", instance).insert(BOOK_ROWS).run();
      await Table("bare", instance).insert(BOOK_ROWS).run();
      await Table("notes", instance).insert(NOTE_ROWS).run();
    }
    await Table("reviews").insert(REVIEW_ROWS).run();
    await Table("loose").insert(LOOSE_ROWS).run();
    await WaitForIndexes(SCHEMA_ID);
    for (const table of ["indexed", "bare", "reviews", "loose", "notes"]) {
      await Run(sql`ANALYZE TABLE ${ident(PhysicalTable(SCHEMA_ID, table))}`);
    }
  });

  it("reads the books once and joins them through a buffer where no index serves the condition", async () => {
    expect(await BooksAccess("bare", CONDITIONS.title)).to.equal(
      UnindexedAccess(),
    );
    expect(await Pairs("bare", CONDITIONS.title)).to.deep.equal(EXPECTED);
  });

  it("compares the hashes of a key both sides compare as JSON through a join buffer on MariaDB, for a page or an unbounded list of reviews", async () => {
    for (const count of [REVIEWS, undefined]) {
      expect(await JoinAccess(LooseJoined(Notes(count)), REVIEWS)).to.equal(
        GetDialect().id === "mysql"
          ? "range PRIMARY buffered"
          : "derived ALL null buffered, eq_ref PRIMARY",
      );
      expect(await LoosePairs(Notes(count))).to.deep.equal(LOOSE_EXPECTED);
    }
  });

  it("joins the table itself for one review, a page of one or one a filter names by `_id`, with or without a page or a later filter", async () => {
    for (const notes of OneNote()) {
      expect(await JoinAccess(LooseJoined(notes))).to.not.include("derived");
      expect(await LoosePairs(notes)).to.deep.equal([EXPECTED[0]]);
    }
  });

  it("hashes the keys of a left side a filter does not bound to one row", async () => {
    for (const [notes, pairs] of Unbound()) {
      expect(await JoinAccess(LooseJoined(notes))).to.include(HashedAccess());
      expect(await LoosePairs(notes)).to.deep.equal(pairs);
    }
  });

  it("answers the same pairs where no index serves a fallback read, in either operand order", async () => {
    const swapped: Condition = (review, book) =>
      review
        .key("bookTitle")
        .eq(book.key("title").key("fr").default(book.key("title").key("en")));
    for (const condition of [CONDITIONS.fallback, swapped]) {
      expect(await BooksAccess("bare", condition)).to.equal(UnindexedAccess());
      expect(await Pairs("bare", condition)).to.deep.equal(
        [...EXPECTED, "r-fallback b-1"].sort(),
      );
    }
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

  it("joins inside a map on a condition that also reads the mapped row", async () => {
    const fallback = (review: ValueProxy<Review>) =>
      review.key("_id").eq("r-fallback");
    const answer = await Table("reviews")
      .filter(fallback)
      .map((outer) => ({
        review: outer.key("_id"),
        books: Table("reviews")
          .filter(fallback)
          .joinInner(
            Table("bare"),
            (review, book) =>
              book
                .key("title")
                .key("fr")
                .default(outer.key("bookTitle"))
                .eq(review.key("bookTitle")),
            (_review, book) => book.key("_id"),
          )
          .slice(0, 5),
      }))
      .run();
    expect(answer).to.deep.equal([{ review: "r-fallback", books: ["b-1"] }]);
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
