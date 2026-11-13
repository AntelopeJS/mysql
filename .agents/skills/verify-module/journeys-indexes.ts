import { has, type Journey } from "@antelopejs/tooling-configs/verify";

import { pick, text } from "./json.ts";
import { answered, close, logs, open, ownedConfig, part, same, sees, seed, server, sql, type Engine } from "./session.ts";

const BARE = `{ items: { fields: { price: "number", sku: "string" }, indexes: {} } }`;
const UNIQUE = `{ items: { fields: { price: "number", sku: "string" }, indexes: { price: { unique: true } } } }`;
const TABLE = "verify-refused__items";

const REFUSAL = /^Write refused: unique index 'price' on 'verify-refused\.items' is not built, because the server refused it \(Duplicate entry '7'/u;

const ATTEMPT = `const attempt = async (write) => { try { await write; return "stored"; } catch (error) { return String(error.message); } };`;

export const refusedUniqueIndex = (engine: Engine): Journey => ({
  title: "a unique index the server refuses over duplicates refuses the writes it would check, keeps reads, deletes and other updates working, and is built once the rows are cleaned and the schema registers again",
  entryPoint: "`unique: true` added to a schema whose rows share a key, changed between runs of `ajs project dev`, then written from a consumer module",
  async run(context) {
    const first = await open(context, ownedConfig(server(context, engine)));
    const created = await first.run("create the table", `await new Schema("verify-refused", ${BARE}).instance().table("items").count().run(); return "created";`);
    context.expect(created.folder, [answered(created)], { critical: true });
    await close(first);
    await seed(context, engine, "store two rows that share a price", `INSERT INTO \`${TABLE}\` (_id, _instance, sku, price) VALUES ('a', '', 'sku-a', 7), ('b', '', 'sku-b', 7), ('c', '', 'sku-c', 8)`);

    const refused = await open(context, ownedConfig(server(context, engine)));
    const writes = await refused.run(
      "write while the server refuses the unique index",
      `const items = new Schema("verify-refused", ${UNIQUE}).instance().table("items");
${ATTEMPT}
return {
  insert: await attempt(items.insert({ _id: "d", price: 7 }).run()),
  setsIndexed: await attempt(items.get("c").update({ price: 7 }).run()),
  setsOther: await attempt(items.get("c").update({ sku: "renamed" }).run()),
  deletes: await attempt(items.get("b").delete().run()),
  read: (await items.get("a").run())?.price ?? null,
};`,
    );
    context.expect(writes.folder, [answered(writes)], { critical: true });
    context.expect(writes.folder, [
      has("an insert is refused, naming the index and the server's reason", text(pick(writes.value, "insert")), REFUSAL),
      has("an update that sets the indexed field is refused", text(pick(writes.value, "setsIndexed")), REFUSAL),
      sees("an update of another field goes through", part(writes, "setsOther"), "stored"),
      sees("a delete goes through", part(writes, "deletes"), "stored"),
      sees("a read answers", part(writes, "read"), 7),
    ]);
    context.expect(writes.folder, [has("the index phase warns that it could not build the index", await logs(refused), /could not build unique index 'price': Duplicate entry '7'/u)]);
    await close(refused);
    const stored = await sql(context, engine, "read the rows the refused writes left", `SELECT JSON_ARRAYAGG(JSON_ARRAY(_id, price)) FROM (SELECT _id, price FROM \`${TABLE}\` ORDER BY _id) r`);
    context.expect(stored.folder, [same("no refused write stored a row, and the delete removed b", stored.value, [["a", 7], ["c", 8]])]);

    const rebuilt = await open(context, ownedConfig(server(context, engine)));
    const after = await rebuilt.run(
      "write once the schema registers again over clean rows",
      `const items = new Schema("verify-refused", ${UNIQUE}).instance().table("items");
${ATTEMPT}
let duplicate;
try { await items.insert({ _id: "f", price: 7 }).run(); duplicate = "stored"; } catch (error) { duplicate = error.name; }
return { insert: await attempt(items.insert({ _id: "e", price: 9 }).run()), duplicate };`,
    );
    context.expect(after.folder, [answered(after)], { critical: true });
    context.expect(after.folder, [
      sees("an insert goes through once the index is built", part(after, "insert"), "stored"),
      sees("a duplicate throws DuplicateKeyError from the built index", part(after, "duplicate"), "DuplicateKeyError"),
    ]);
    await close(rebuilt);
    const index = await sql(context, engine, "read the price index", `SELECT JSON_ARRAYAGG(NON_UNIQUE) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = 'verify' AND TABLE_NAME = '${TABLE}' AND INDEX_NAME = 'price'`);
    context.expect(index.folder, [same("the unique price index exists", index.value, [0, 0])]);
  },
});
