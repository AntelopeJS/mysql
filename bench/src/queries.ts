import type { Table, ValueProxy } from "@antelopejs/interface-database";
import {
  LocalizationModifier,
  unlockrequest,
} from "@antelopejs/interface-database-decorators";

import {
  BookId,
  HeadingFr,
  INDEXES,
  LocalizedBook,
  PATHS,
  ReviewedBooks,
  ReviewId,
  TitleFr,
  type StoredBook,
  type StoredReview,
} from "./dataset";

/** The tables one query reads: the books with or without the declared indexes, and the reviews. */
export interface QueryTables {
  readonly books: Table<StoredBook>;
  readonly reviews: Table<StoredReview>;
  readonly indexed: boolean;
  readonly rows: number;
}

export type QueryKind = "filter" | "orderBy" | "lookup";

/** `title` is the book's own `title.fr`; `heading` is the `title.fr` `@Localized` keeps in `_internal`. */
export type FieldKey = keyof typeof PATHS;

/**
 * How the query names the field. `path` hands the stage the dotted path, or the index name where
 * the table declares one, as `orderBy` and `lookup` take them. `keys` chains `key()` down the stored
 * path in an expression. `decorators` is the expression `unlockrequest` builds, with its fallback.
 */
export type QueryForm = "path" | "keys" | "decorators";

/** One query of the benchmark, before it is bound to a table with or without indexes. */
export interface QuerySpec {
  readonly kind: QueryKind;
  readonly field: FieldKey;
  readonly form: QueryForm;
  /**
   * Runs the query and answers how to read what identifies its answer: ids, in order where the
   * query defines one. Reading it is left to the caller, outside the time it measures.
   */
  readonly run: (tables: QueryTables) => Promise<() => string[]>;
  readonly expected: (rows: number) => string[];
}

/** A query bound to one of the two book tables. */
export interface QueryCase extends QuerySpec {
  readonly id: string;
  readonly indexed: boolean;
}

export const PAGE = 20;
const FILTERED_BOOK = 54321;

/** The one book the filters find, inside any row count. */
function FilteredBook(rows: number): number {
  return FILTERED_BOOK % rows;
}

/** `title` as the decorators read it in French: the `fr` text, else the `en` fallback. */
function LocalizedTitle(row: ValueProxy<StoredBook>): ValueProxy<string> {
  return unlockrequest(LocalizedBook, row.cast<LocalizedBook>(), "title", [
    { modifier: LocalizationModifier, args: ["fr"] },
  ]);
}

function PlainTitle(row: ValueProxy<StoredBook>): ValueProxy<string> {
  return row.key("title").key("fr");
}

function PlainHeading(row: ValueProxy<StoredBook>): ValueProxy<string> {
  return row.key("_internal").key("data").key("title").key("fr");
}

/**
 * The books typed with each dotted path as a key: `lookup` types its other key as a key of the
 * other row, and a nested path is a key of none.
 */
function Dotted(books: Table<StoredBook>) {
  return books.cast<StoredBook & Record<(typeof PATHS)[FieldKey], string>>();
}

/** A row as an answer holds it; a book a lookup or join did not find is `null`. */
interface Identified {
  readonly _id?: string;
}

function IdOf(row: Identified | null | undefined): string {
  return row?._id ?? "<none>";
}

function Ids(rows: readonly Identified[]): string[] {
  return rows.map(IdOf);
}

/** `review -> book` per answered review, sorted: a page without `orderBy` may be any 20 reviews. */
function Pair(review: Identified, book: Identified | null | undefined): string {
  return `${IdOf(review)} -> ${IdOf(book)}`;
}

/** The ids of the first {@link PAGE} books by a text, given the text of each book. */
function FirstByText(rows: number, text: (book: number) => string): string[] {
  return Array.from({ length: rows }, (_, book) => book)
    .sort((left, right) => (text(left) < text(right) ? -1 : 1))
    .slice(0, PAGE)
    .map(BookId);
}

/** The pairs a lookup of the first {@link PAGE} reviews answers, by the key they name their book with. */
function ExpectedPairs(rows: number, key: "byTitle" | "byHeading"): string[] {
  return Array.from(
    { length: PAGE },
    (_, review) =>
      `${ReviewId(review)} -> ${BookId(ReviewedBooks(review, rows)[key])}`,
  ).sort();
}

type Expression = (row: ValueProxy<StoredBook>) => ValueProxy<string>;

/** What each field is read by: its expressions by form, its text, and the review key naming it. */
interface FieldReading {
  readonly expressions: Partial<
    Record<(typeof EXPRESSION_FORMS)[number], Expression>
  >;
  readonly text: (book: number, rows: number) => string;
  readonly reviewKey: "bookTitle" | "bookHeading";
  readonly reviewed: "byTitle" | "byHeading";
}

const FIELDS: Record<FieldKey, FieldReading> = {
  title: {
    expressions: { keys: PlainTitle },
    text: TitleFr,
    reviewKey: "bookTitle",
    reviewed: "byTitle",
  },
  heading: {
    expressions: { keys: PlainHeading, decorators: LocalizedTitle },
    text: HeadingFr,
    reviewKey: "bookHeading",
    reviewed: "byHeading",
  },
};

const SORT_KEY = "sortKey";
const EXPRESSION_FORMS = ["keys", "decorators"] as const;

type Run = QuerySpec["run"];

function Filter(field: FieldKey, read: Expression): Run {
  return async ({ books, rows }) => {
    const found = await books
      .filter((row) =>
        read(row).eq(FIELDS[field].text(FilteredBook(rows), rows)),
      )
      .run();
    return () => Ids(found).sort();
  };
}

function OrderByPath(field: FieldKey): Run {
  return async ({ books, indexed }) => {
    const page = await books
      .orderBy(indexed ? INDEXES[field] : PATHS[field])
      .slice(0, PAGE)
      .run();
    return () => Ids(page);
  };
}

function OrderByExpression(read: Expression): Run {
  return async ({ books }) => {
    const page = await books
      .map((row) => ({ _id: row.key("_id"), [SORT_KEY]: read(row) }))
      .orderBy(SORT_KEY)
      .slice(0, PAGE)
      .run();
    return () => Ids(page);
  };
}

function LookupPath(field: FieldKey): Run {
  const key = FIELDS[field].reviewKey;
  return async ({ books, reviews }) => {
    const page = await reviews
      .slice(0, PAGE)
      .lookup(Dotted(books), key, PATHS[field])
      .run();
    return () => page.map((review) => Pair(review, review[key])).sort();
  };
}

function JoinExpression(field: FieldKey, read: Expression): Run {
  return async ({ books, reviews }) => {
    const page = await reviews
      .slice(0, PAGE)
      .joinInner(
        books,
        (review, book) => read(book).eq(review.key(FIELDS[field].reviewKey)),
        (review, book) => ({ review, book }),
      )
      .run();
    return () => page.map(({ review, book }) => Pair(review, book)).sort();
  };
}

function Specs(field: FieldKey): QuerySpec[] {
  const reading = FIELDS[field];
  const sorted = (rows: number) =>
    FirstByText(rows, (book) => reading.text(book, rows));
  const paired = (rows: number) => ExpectedPairs(rows, reading.reviewed);
  const found = (rows: number) => [BookId(FilteredBook(rows))];
  const expressions = EXPRESSION_FORMS.flatMap((form) => {
    const read = reading.expressions[form];
    return read ? [{ form, read }] : [];
  });
  return [
    ...expressions.map(({ form, read }) => ({
      kind: "filter" as const,
      field,
      form,
      run: Filter(field, read),
      expected: found,
    })),
    {
      kind: "orderBy",
      field,
      form: "path",
      run: OrderByPath(field),
      expected: sorted,
    },
    ...expressions.map(({ form, read }) => ({
      kind: "orderBy" as const,
      field,
      form,
      run: OrderByExpression(read),
      expected: sorted,
    })),
    {
      kind: "lookup",
      field,
      form: "path",
      run: LookupPath(field),
      expected: paired,
    },
    ...expressions.map(({ form, read }) => ({
      kind: "lookup" as const,
      field,
      form,
      run: JoinExpression(field, read),
      expected: paired,
    })),
  ];
}

/** The kinds of query, in the order the report lists them. */
export const KINDS: readonly QueryKind[] = ["filter", "orderBy", "lookup"];

/** Every query, on the table without indexes and on the one with them. */
export function QueryCases(): QueryCase[] {
  const specs = [...Specs("title"), ...Specs("heading")].sort(
    (left, right) => KINDS.indexOf(left.kind) - KINDS.indexOf(right.kind),
  );
  return specs.flatMap((spec) =>
    [false, true].map((indexed) => ({
      ...spec,
      indexed,
      id: [spec.kind, spec.field, spec.form, indexed ? "indexed" : "bare"].join(
        ":",
      ),
    })),
  );
}
