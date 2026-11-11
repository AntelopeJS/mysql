import { expect } from "chai";
import type { StagedObject } from "@antelopejs/interface-database/common";
import { Schema } from "@antelopejs/interface-database/schema";

import { AcquireConnection, GetDialect, Read, type Row } from "../connection";
import { type Sql, ident, sql } from "../statement";
import { DecodingContext } from "../implementations/database/context";
import { CompileExpression } from "../implementations/database/expression";
import { CompileSubquery } from "../implementations/database/subquery";
import { CompileRelation } from "../implementations/database/pipeline";
import { Render } from "../implementations/database/render";
import {
  GetTablePlan,
  WaitForIndexes,
} from "../implementations/database/schema";
import { SessionOf } from "../implementations/database/locks";
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
    fields: { titleKey: "string", articleIds: "string[]" },
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
  { _id: "p1", titleKey: "titre 5", articleIds: ["a7", "a9"] },
  { _id: "p2", titleKey: "titre 1999", articleIds: [] },
  { _id: "p3", titleKey: "absent", articleIds: ["missing"] },
];

/** A statement compiled as `RunQuery` compiles a read, against the live registry. */
function Compiled(query: StagedObject): Sql {
  const context = new DecodingContext(
    {
      expression: CompileExpression,
      subquery: CompileSubquery,
      relation: CompileRelation,
    },
    GetDialect(),
  );
  return Render(CompileRelation(query.build(), context));
}

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
    "serves a lookup on an indexed nested path with a ref on the other table's index",
    LookupPlan,
  );
  it(
    "groups over declared columns in SQL that ONLY_FULL_GROUP_BY accepts",
    GroupFullMode,
  );
});
