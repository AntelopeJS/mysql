import type { Journey } from "@antelopejs/tooling-configs/verify";

import { pick } from "./json.ts";
import { answered, close, open, orderedArray, ownedConfig, part, same, sees, server, sql, type Engine } from "./session.ts";

const CATALOG = `{ products: { fields: { name: "string", price: "number", category: "string", tags: "string[]" }, indexes: { price: {}, category: {} } }, categories: { fields: { label: "string" }, indexes: {} } }`;

const PRODUCTS = "`verify-reads__products`";

const COMPARED = ["cheap", "byPriceDesc", "between", "getAll", "count", "groups", "streamed"];

/** A JSON array of `value` over the products `where` keeps, in `order`. */
function ordered(value: string, order: string, where = "TRUE"): string {
  return orderedArray(value, order, `${PRODUCTS} WHERE ${where}`);
}

export const readQueries = (engine: Engine): Journey => ({
  title: "filter, orderBy, between, getAll, pluck, count, group and a lookup answer what the same SQL answers, NULL sorts first ascending, text compares by code point, and a cursor reads past its batch size",
  entryPoint: "`table.filter/orderBy/between/getAll/pluck/count/group/lookup` and `for await` over a stream from a consumer module, with `cursorBatchSize: 2`",
  async run(context) {
    const session = await open(context, { ...ownedConfig(server(context, engine)), cursorBatchSize: 2 });
    const result = await session.run(
      "query the products",
      `const schema = new Schema("verify-reads", ${CATALOG});
const products = schema.instance().table("products");
await schema.instance().table("categories").insert([{ _id: "c1", label: "Lighting" }, { _id: "c2", label: "Furniture" }]).run();
await products.insert([
  { _id: "p1", name: "lamp", price: 10, category: "c1", tags: ["home"] },
  { _id: "p2", name: "desk", price: 90, category: "c2", tags: ["office"] },
  { _id: "p3", name: "chair", price: 45, category: "c2", tags: ["office", "home"] },
  { _id: "p4", name: "bulb", price: 2, category: "c1", tags: [] },
  { _id: "p5", name: "shelf", price: 60, category: "c2", tags: ["home"] },
  { _id: "p6", name: "Vase", category: "c1", tags: ["home"] },
]).run();
const out = {};
out.cheap = (await products.filter((p) => p.key("price").lt(50)).orderBy("price").run()).map((p) => p._id);
out.byPriceDesc = (await products.orderBy("price", "desc").pluck("name").run()).map((p) => p.name);
out.between = (await products.between("price", 10, 60).orderBy("price").run()).map((p) => p._id);
out.getAll = (await products.getAll("c1", "category").orderBy("price").run()).map((p) => p._id);
out.count = await products.filter((p) => p.key("tags").includes("home")).count().run();
out.groups = (await products.group("category", (rows, category) => ({ category, n: rows.count() })).run()).map((g) => [g.category, g.n]).sort();
out.nullFirst = (await products.orderBy("price").run()).map((p) => p._id)[0];
out.byName = (await products.orderBy("name").run()).map((p) => p.name);
out.caseSensitive = (await products.filter((p) => p.key("name").eq("vase")).run()).length;
out.joined = (await products.get("p2").lookup(schema.instance().table("categories"), "category", "_id").run());
const streamed = [];
for await (const p of products.orderBy("_id")) streamed.push(p._id);
out.streamed = streamed;
return out;`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    const expected = await sql(
      context,
      engine,
      "the same reads in SQL",
      `SELECT JSON_OBJECT(
  'cheap', ${ordered("JSON_QUOTE(_id)", "price", "price < 50")},
  'byPriceDesc', ${ordered("JSON_QUOTE(name)", "price DESC")},
  'between', ${ordered("JSON_QUOTE(_id)", "price", "price >= 10 AND price < 60")},
  'getAll', ${ordered("JSON_QUOTE(_id)", "price", "category = 'c1'")},
  'count', (SELECT COUNT(*) FROM ${PRODUCTS} WHERE JSON_CONTAINS(tags, '"home"')),
  'groups', ${orderedArray("JSON_ARRAY(category, n)", "category", `(SELECT category, COUNT(*) AS n FROM ${PRODUCTS} GROUP BY category) g`)},
  'streamed', ${ordered("JSON_QUOTE(_id)", "_id")})`,
    );
    context.expect(result.folder, [
      ...COMPARED.map((key) => same(`${key} answers what the same SQL answers`, pick(result.value, key), pick(expected.value, key))),
      sees("a row with no price sorts first on an ascending orderBy", part(result, "nullFirst"), "p6"),
      sees("text sorts by code point, so an uppercase initial comes before every lowercase one", part(result, "byName"), ["Vase", "bulb", "chair", "desk", "lamp", "shelf"]),
      sees("text equality is case-sensitive", part(result, "caseSensitive"), 0),
      sees("lookup joins the matching row under the local key", part(result, "joined"), {
        _id: "p2",
        category: { _id: "c2", label: "Furniture" },
        name: "desk",
        price: 90,
        tags: ["office"],
      }),
    ]);
    await close(session);
  },
});
