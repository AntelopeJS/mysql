import type { SchemaDefinition } from "@antelopejs/interface-database";
import {
  LocalizationModifier,
  Localized,
  Table,
  toDatabase,
} from "@antelopejs/interface-database-decorators";

/** A text in each locale the benchmark writes. */
export interface LocaleTexts {
  fr: string;
  en: string;
}

/** What `@Localized` keeps for a row, as `toDatabase` writes it. */
export interface InternalRecord {
  meta: Record<string, never>;
  data: { title: LocaleTexts; summary: LocaleTexts };
}

/** A book as stored: a `{ fr, en }` record of its own, and the decorators' `_internal`. */
export interface StoredBook {
  _id: string;
  category: string;
  title: LocaleTexts;
  _internal: InternalRecord;
}

/** A review, which names its book by one of the book's French titles. */
export interface StoredReview {
  _id: string;
  rating: number;
  bookTitle: string;
  bookHeading: string;
}

/** The table class the decorators read `title` and `summary` of, through `localize`. */
export class LocalizedBook extends Table.with(LocalizationModifier) {
  @Localized({ fallbackLocale: "en" })
  declare title: string;

  @Localized({ fallbackLocale: "en" })
  declare summary: string;
}

export const SCHEMA_ID = "nested-bench";
export const INSTANCE_ID = "bench";

/** The physical tables: the same books with and without the declared indexes, and the reviews. */
export const TABLES = {
  bare: "books_bare",
  indexed: "books_indexed",
  reviews: "reviews",
} as const;

/** The index names, as `orderBy` takes them on the indexed table. */
export const INDEXES = {
  title: "titleFr",
  heading: "internalTitleFr",
} as const;

/** The dotted paths the indexes declare, which `orderBy` and `lookup` also take as field names. */
export const PATHS = {
  title: "title.fr",
  heading: "_internal.data.title.fr",
} as const;

const BOOK_FIELDS = {
  category: "string",
  title: { fr: "string", en: "string" },
} as const;

export const SCHEMA: SchemaDefinition = {
  [TABLES.bare]: { fields: BOOK_FIELDS, indexes: {} },
  [TABLES.indexed]: {
    fields: BOOK_FIELDS,
    indexes: {
      [INDEXES.title]: { fields: [PATHS.title] },
      [INDEXES.heading]: { fields: [PATHS.heading] },
    },
  },
  [TABLES.reviews]: {
    fields: { rating: "number", bookTitle: "string", bookHeading: "string" },
    indexes: {},
  },
};

const DIGITS = 6;
const CATEGORIES = 40;
const RATINGS = 5;
const TITLE_STRIDE = 7919;
const HEADING_STRIDE = 7907;
const REVIEW_TITLE_STRIDE = 4999;
const REVIEW_HEADING_STRIDE = 4993;
const SUMMARY_FR =
  "Un récit qui suit ses personnages sur plusieurs générations, entre la ville et la campagne, et qui revient sur ce que chacun a laissé derrière lui.";
const SUMMARY_EN =
  "A story that follows its characters across several generations, between the city and the countryside, and returns to what each of them left behind.";

function Padded(value: number): string {
  return String(value).padStart(DIGITS, "0");
}

/** A bijection of `[0, rows)`, so the titles sort in another order than the ids. */
function Permuted(index: number, stride: number, rows: number): number {
  return (index * stride) % rows;
}

export function BookId(index: number): string {
  return `book-${Padded(index)}`;
}

export function ReviewId(index: number): string {
  return `review-${Padded(index)}`;
}

/** The top-level `title.fr` of a book. */
export function TitleFr(book: number, rows: number): string {
  return `titre ${Padded(Permuted(book, TITLE_STRIDE, rows))}`;
}

/** The French `title` the decorators keep in `_internal.data.title.fr`. */
export function HeadingFr(book: number, rows: number): string {
  return `intitulé ${Padded(Permuted(book, HEADING_STRIDE, rows))}`;
}

/** The books a review names: by their top-level title, and by their localized title. */
export interface ReviewedBookIndexes {
  readonly byTitle: number;
  readonly byHeading: number;
}

export function ReviewedBooks(
  review: number,
  rows: number,
): ReviewedBookIndexes {
  return {
    byTitle: Permuted(review, REVIEW_TITLE_STRIDE, rows),
    byHeading: Permuted(review, REVIEW_HEADING_STRIDE, rows),
  };
}

/** The book at `index`, written through `@Localized` and `toDatabase` as a model would write it. */
export function Book(index: number, rows: number): StoredBook {
  const book = new LocalizedBook();
  const heading = Permuted(index, HEADING_STRIDE, rows);
  book.localize("fr").title = HeadingFr(index, rows);
  book.localize("en").title = `heading ${Padded(heading)}`;
  book.localize("fr").summary = SUMMARY_FR;
  book.localize("en").summary = SUMMARY_EN;
  const stored = toDatabase(book)._internal?.data;
  const localizedTitle = stored?.title;
  const summary = stored?.summary;
  if (!IsLocaleTexts(localizedTitle) || !IsLocaleTexts(summary)) {
    throw new Error("@Localized stored no { fr, en } record");
  }
  const title = Permuted(index, TITLE_STRIDE, rows);
  return {
    _id: BookId(index),
    category: `category-${index % CATEGORIES}`,
    title: { fr: TitleFr(index, rows), en: `title ${Padded(title)}` },
    _internal: {
      meta: {},
      data: {
        title: { fr: localizedTitle.fr, en: localizedTitle.en },
        summary: { fr: summary.fr, en: summary.en },
      },
    },
  };
}

function IsLocaleTexts(value: unknown): value is LocaleTexts {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "fr") &&
    Object.hasOwn(value, "en") &&
    "fr" in value &&
    "en" in value &&
    typeof value.fr === "string" &&
    typeof value.en === "string"
  );
}

export function Review(index: number, rows: number): StoredReview {
  const books = ReviewedBooks(index, rows);
  return {
    _id: ReviewId(index),
    rating: (index % RATINGS) + 1,
    bookTitle: TitleFr(books.byTitle, rows),
    bookHeading: HeadingFr(books.byHeading, rows),
  };
}
