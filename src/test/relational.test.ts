import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

import { AcquireConnection, Read, type Row } from "../connection";
import { ident, sql } from "../statement";
import {
  GetTablePlan,
  WaitForIndexes,
} from "../implementations/database/schema";
import { SessionOf } from "../implementations/database/locks";
import { Compiled } from "./compiled";
import { PhysicalTable, Run } from "./tables";

const SCHEMA_ID = "relational";
const INSTANCE = "one";
const ARTICLES = 2000;

interface Article {
  _id: string;
  slug: string;
  title: { fr: string; en: string };
  views: number;
  published: boolean;
  "title.fr": string;
}

interface Post {
  _id: string;
  titleKey: string;
  articleIds: string[];
  take: number;
}

const schema = new Schema<{ articles: Article; posts: Post }>(SCHEMA_ID, {
  articles: {
    fields: {
      slug: "string",
      title: "object",
      views: "number",
      published: "boolean",
    },
    indexes: { titleFr: { fields: ["title.fr"] } },
  },
  posts: {
    fields: { titleKey: "string", articleIds: "string[]", take: "number" },
    indexes: {},
  },
});

function Articles() {
  return schema.instance(INSTANCE).table("articles");
}

function Posts() {
  return schema.instance(INSTANCE).table("posts");
}

const POSTS: Post[] = [
  { _id: "p1", titleKey: "titre 5", articleIds: ["a7", "a9"], take: 2 },
  { _id: "p2", titleKey: "titre 1999", articleIds: [], take: 0 },
  { _id: "p3", titleKey: "absent", articleIds: ["missing"], take: 1.9 },
];

/** Every article's slug in the order the binary collation sorts them, which ASCII code order is. */
const SORTED_SLUGS = Array.from(
  { length: ARTICLES },
  (_, n) => `slug-${n}`,
).sort();

function Text(row: Row, column: string): string {
  const cell = row.get(column);
  return Buffer.isBuffer(cell) ? cell.toString("utf8") : String(cell);
}

async function Seed(): Promise<void> {
  await schema.createInstance(INSTANCE).run();
  await Articles()
    .insert(
      Array.from({ length: ARTICLES }, (_, n) => ({
        _id: `a${n}`,
        slug: `slug-${n}`,
        title: { fr: `titre ${n}`, en: `title ${n}` },
        views: n % 10,
        published: n % 2 === 0,
      })),
    )
    .run();
  await Posts().insert(POSTS).run();
  await WaitForIndexes(SCHEMA_ID);
  await Run(sql`ANALYZE TABLE ${ident(PhysicalTable(SCHEMA_ID, "articles"))}`);
}

async function LeftJoin(): Promise<void> {
  const joined = await Posts()
    .join(
      Articles(),
      (post, article) =>
        post.key("titleKey").eq(article.key("title").key("fr")),
      (post, article) => ({
        post: post.key("_id"),
        slug: article.key("slug"),
      }),
    )
    .run();
  expect(joined).to.have.deep.members([
    { post: "p1", slug: "slug-5" },
    { post: "p2", slug: "slug-1999" },
    { post: "p3", slug: null },
  ]);
}

async function InnerJoin(): Promise<void> {
  const joined = await Posts()
    .joinInner(
      Articles(),
      (post, article) =>
        post.key("titleKey").eq(article.key("title").key("fr")),
      (post, article) => ({
        post: post.key("_id"),
        views: article.key("views"),
      }),
    )
    .run();
  expect(joined).to.have.deep.members([
    { post: "p1", views: 5 },
    { post: "p2", views: 9 },
  ]);
}

async function LookupByPath(): Promise<void> {
  const found = await Posts()
    .lookup(Articles(), "titleKey", "title.fr")
    .map((post) => ({
      id: post.key("_id"),
      slug: post.key("titleKey").key("slug"),
    }))
    .run();
  expect(found).to.have.deep.members([
    { id: "p1", slug: "slug-5" },
    { id: "p2", slug: "slug-1999" },
    { id: "p3", slug: null },
  ]);
}

async function LookupList(): Promise<void> {
  const found = await Posts()
    .lookup(Articles().pluck("_id", "views"), "articleIds", "_id")
    .map((post) => ({ id: post.key("_id"), found: post.key("articleIds") }))
    .run();
  expect(found).to.have.deep.members([
    {
      id: "p1",
      found: [
        { _id: "a7", views: 7 },
        { _id: "a9", views: 9 },
      ],
    },
    { id: "p2", found: [] },
    { id: "p3", found: [] },
  ]);
}

async function LookupOrderedList(): Promise<void> {
  const found = await Posts()
    .lookup(
      Articles().orderBy("views", "desc").pluck("_id", "views"),
      "articleIds",
      "_id",
    )
    .map((post) => ({ id: post.key("_id"), found: post.key("articleIds") }))
    .run();
  expect(found).to.have.deep.members([
    {
      id: "p1",
      found: [
        { _id: "a9", views: 9 },
        { _id: "a7", views: 7 },
      ],
    },
    { id: "p2", found: [] },
    { id: "p3", found: [] },
  ]);
}

async function LookupMappedOrderedList(): Promise<void> {
  const found = await Posts()
    .lookup(
      Articles()
        .map((article) => ({
          _id: article.key("_id"),
          views: article.key("views"),
        }))
        .orderBy("views", "desc"),
      "articleIds",
      "_id",
    )
    .map((post) => ({ id: post.key("_id"), found: post.key("articleIds") }))
    .run();
  expect(found).to.have.deep.members([
    {
      id: "p1",
      found: [
        { _id: "a9", views: 9 },
        { _id: "a7", views: 7 },
      ],
    },
    { id: "p2", found: [] },
    { id: "p3", found: [] },
  ]);
}

async function LookupPlan(): Promise<void> {
  const index = GetTablePlan(SCHEMA_ID, "articles").indexes.find(
    (planned) => planned.id === "titleFr",
  );
  const plan = await Read(
    sql`EXPLAIN FORMAT=TRADITIONAL ${Compiled(Posts().lookup(Articles(), "titleKey", "title.fr"))}`,
  );
  const inner = plan.filter((row) => Text(row, "key") === index?.name);
  expect(inner.map((row) => Text(row, "type"))).to.deep.equal(["ref"]);
}

async function GroupFullMode(): Promise<void> {
  const statement = Compiled(
    Articles().group("published", (stream, published) => ({
      published,
      count: stream.count(),
      views: stream.sum("views"),
      slugs: stream.distinct("views"),
    })),
  );
  const held = await AcquireConnection();
  try {
    await SessionOf(held).apply(
      sql`SET SESSION sql_mode = CONCAT(@@sql_mode, ',ONLY_FULL_GROUP_BY')`,
    );
    const rows = await Read(statement, held);
    expect(rows).to.have.lengthOf(2);
  } finally {
    held.destroy();
  }
}

async function SliceByCount(): Promise<void> {
  const slugs = await Articles()
    .orderBy("slug")
    .slice(1, Posts().count())
    .map((article) => article.key("slug"))
    .run();
  expect(slugs).to.deep.equal(SORTED_SLUGS.slice(1, 1 + POSTS.length));
  const nth = await Articles().orderBy("slug").nth(Posts().count()).run();
  expect(nth?.slug).to.equal(SORTED_SLUGS[POSTS.length]);
}

async function SliceByOuterRow(): Promise<void> {
  const taken = await Posts()
    .map((post) => ({
      id: post.key("_id"),
      slugs: Articles()
        .orderBy("slug")
        .slice(0, post.key("take"))
        .map((article) => article.key("slug")),
    }))
    .run();
  expect(taken).to.have.deep.members([
    { id: "p1", slugs: SORTED_SLUGS.slice(0, 2) },
    { id: "p2", slugs: [] },
    { id: "p3", slugs: SORTED_SLUGS.slice(0, 1) },
  ]);
}

/** The slugs of the articles whose views equal `take`, in descending binary order. */
function SlugsViewed(take: number): string[] {
  return Array.from({ length: ARTICLES }, (_, n) => n)
    .filter((n) => n % 10 === take)
    .map((n) => `slug-${n}`)
    .sort()
    .reverse();
}

async function DedupAndBoundByOuterRow(): Promise<void> {
  const read = await Posts()
    .map((post) => ({
      id: post.key("_id"),
      views: Articles()
        .filter((article) => article.key("views").eq(post.key("take")))
        .map((article) => article.key("views"))
        .distinct(),
      slugs: Articles()
        .filter((article) => article.key("views").eq(post.key("take")))
        .orderBy("slug", "desc")
        .slice(1, 2)
        .map((article) => article.key("slug")),
    }))
    .run();
  expect(read).to.have.deep.members([
    { id: "p1", views: [2], slugs: SlugsViewed(2).slice(1, 3) },
    { id: "p2", views: [0], slugs: SlugsViewed(0).slice(1, 3) },
    { id: "p3", views: [], slugs: [] },
  ]);
}

describe("relational stages on a real server", function () {
  this.timeout(60_000);

  before(Seed);

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  it(
    "keeps every left row through a left join, a missed right row reading null",
    LeftJoin,
  );
  it("keeps only matched rows through an inner join", InnerJoin);
  it(
    "looks up one row by a nested path, and null where none matches",
    LookupByPath,
  );
  it("looks up every row a list key names, an empty list for none", LookupList);
  it(
    "collects the rows a list key names in the order the looked-up query asks for",
    LookupOrderedList,
  );
  it(
    "keeps that order when the looked-up query is wrapped before its correlation",
    LookupMappedOrderedList,
  );
  it(
    "serves a lookup on an indexed nested path with a ref on the other table's index",
    LookupPlan,
  );
  it(
    "groups over declared columns in SQL that ONLY_FULL_GROUP_BY accepts",
    GroupFullMode,
  );
  it("slices and picks by a count another query computes", SliceByCount);
  it(
    "slices each row's subquery by a count its own row holds",
    SliceByOuterRow,
  );
  it(
    "dedups, orders and slices each row's subquery that its own row filters",
    DedupAndBoundByOuterRow,
  );
});
