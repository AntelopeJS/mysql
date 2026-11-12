import { has, type Journey, type JourneyContext } from "@antelopejs/tooling-configs/verify";

import { pick, text, type Json } from "./json.ts";
import { answered, client, close, logs, open, ownedConfig, part, same, sees, server, sql, type Engine, type Session } from "./session.ts";

const LAYOUT = `{ items: { fields: { name: "string", price: "number", sku: "string", tags: "string[]", title: "object" }, indexes: { price: {}, name: { crossInstance: true }, sku: { unique: true }, tags: { multi: true }, titleFr: { fields: ["title.fr"] } } } }`;

const TABLE = "verify-layout__items";

const OWNED_INDEXES = ["name", "name__g", "price", "sku", "tags", "titleFr"];

/** Waits, inside the container, until the table holds `count` indexes besides its primary key: secondary indexes converge in the background after registration. */
async function indexesBuilt(context: JourneyContext, engine: Engine, count: number): Promise<void> {
  const query = `SELECT COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = 'verify' AND TABLE_NAME = '${TABLE}' AND INDEX_NAME <> 'PRIMARY'`;
  const check = [...client(engine, "verify"), `"${query}"`].join(" ");
  const waited = await context.native("wait for the background index phase", engine.service, [
    "sh",
    "-c",
    `for i in $(seq 150); do n=$(${check}); [ "$n" -ge ${String(count)} ] && exit 0; sleep 0.2; done; echo "$n"; exit 1`,
  ]);
  context.expect(waited.folder, [{ name: `the ${String(count)} declared indexes are built`, pass: waited.exitCode === 0, detail: waited.stdout.trim() }], { critical: true });
}

/** Each index of the table with its key parts in order; only a multi-valued index has a part that is an expression rather than a column. */
function indexRead(engine: Engine): string {
  const part = engine.multiValuedIndex ? "COALESCE(COLUMN_NAME, EXPRESSION)" : "COLUMN_NAME";
  return `SELECT JSON_OBJECTAGG(INDEX_NAME, JSON_OBJECT('unique', JSON_EXTRACT(IF(NON_UNIQUE = 0, 'true', 'false'), '$'), 'parts', parts, 'comment', comment)) FROM (
  SELECT INDEX_NAME, MIN(NON_UNIQUE) AS NON_UNIQUE, MIN(INDEX_COMMENT) AS comment,
    GROUP_CONCAT(${part} ORDER BY SEQ_IN_INDEX SEPARATOR ', ') AS parts
  FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = 'verify' AND TABLE_NAME = '${TABLE}' GROUP BY INDEX_NAME) s`;
}

const COLUMNS = `SELECT JSON_OBJECT(
  'table', (SELECT JSON_OBJECT('collation', TABLE_COLLATION, 'comment', TABLE_COMMENT) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'verify' AND TABLE_NAME = '${TABLE}'),
  'keys', (SELECT JSON_OBJECTAGG(SUBSTRING_INDEX(SUBSTRING(COLUMN_NAME, 5), '_', IF(COLUMN_NAME LIKE '\\_\\_k\\_title\\_fr\\_%', 2, 1)), COLUMN_NAME) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'verify' AND TABLE_NAME = '${TABLE}' AND COLUMN_NAME LIKE '\\_\\_k\\_%'),
  'columns', (SELECT JSON_OBJECTAGG(COLUMN_NAME, JSON_OBJECT('type', COLUMN_TYPE, 'collation', COLLATION_NAME, 'extra', EXTRA, 'expression', GENERATION_EXPRESSION))
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'verify' AND TABLE_NAME = '${TABLE}'))`;

export const storageLayout = (engine: Engine): Journey => ({
  title: `a schema's tables live in the url's database as <schemaId>__<tableId>, keyed (_instance, _id) in ${engine.collation}, and each declared index kind becomes the documented index, a dotted field reading a nested JSON path through a VIRTUAL key column`,
  entryPoint: "`new Schema(id, { table: { fields, indexes } })` and `createInstance` from a consumer module, read back with the mysql client",
  async run(context) {
    const session = await open(context, ownedConfig(server(context, engine)));
    const result = await session.run(
      "register the schema and write into two instances",
      `const schema = new Schema("verify-layout", ${LAYOUT});
await schema.createInstance("a").run();
await schema.createInstance("b").run();
await schema.instance("a").table("items").insert([{ _id: "i1", name: "lamp", price: 10, sku: "S1", tags: ["home"], title: { fr: "Lampe" } }, { _id: "i2", name: "desk", price: 90, sku: "S2", tags: ["office"], title: { fr: "Bureau" } }]).run();
await schema.instance("b").table("items").insert({ _id: "i1", name: "lamp", price: 12, sku: "S1", tags: ["home"] }).run();
return {
  instances: (await schema.listInstances().run()).sort(),
  french: (await schema.instance("a").table("items").filter((i) => i.key("title").key("fr").eq("Lampe")).run()).map((i) => i._id),
};`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    context.expect(result.folder, [
      sees("listInstances answers both instances", part(result, "instances"), ["a", "b"]),
      sees("a filter on the nested path title.fr finds its row", part(result, "french"), ["i1"]),
    ]);
    const built = engine.multiValuedIndex ? OWNED_INDEXES : OWNED_INDEXES.filter((index) => index !== "tags");
    await indexesBuilt(context, engine, built.length);
    const layout = await sql(context, engine, "read the table and its columns", COLUMNS);
    const columns = pick(layout.value, "columns");
    const key = (field: string): string => text(pick(layout.value, "keys", field)) || `<no key column for ${field}>`;
    const name = key("name");
    const sku = key("sku");
    const titleFr = key("title_fr");
    const column = (key: string, field: string): string => text(pick(columns, key, field));
    context.expect(layout.folder, [
      same(`the table is ${engine.collation} and signed as the module's own`, pick(layout.value, "table"), {
        collation: engine.collation,
        comment: `antelopejs:1:table:["verify-layout","items"]`,
      }),
      same(`_id is varchar(512) and _instance varchar(128), both ${engine.collation}`, [column("_id", "type"), column("_id", "collation"), column("_instance", "type"), column("_instance", "collation")], [
        "varchar(512)",
        engine.collation,
        "varchar(128)",
        engine.collation,
      ]),
      same(`a declared string is longtext, a number double, an array, an object and _extra ${engine.documentType}`, [column("name", "type"), column("price", "type"), column("tags", "type"), column("title", "type"), column("_extra", "type")], [
        "longtext",
        "double",
        engine.documentType,
        engine.documentType,
        engine.documentType,
      ]),
      same("a non-unique string index keys on a VIRTUAL varchar(640) prefix of the value", [column(name, "type"), column(name, "extra")], ["varchar(640)", "VIRTUAL GENERATED"]),
      has("the prefix key column holds LEFT(value, 640)", column(name, "expression"), /^left\(`name`,640\)$/u),
      same("a unique string index keys on a VIRTUAL varchar(640) holding the exact value", [column(sku, "type"), column(sku, "extra")], ["varchar(640)", "VIRTUAL GENERATED"]),
      has("the exact key column holds the whole value, with no LEFT", column(sku, "expression"), /^`sku`$/u),
      has("a dotted index field reads the nested JSON path below its declared field", column(titleFr, "expression"), /json_extract\(`title`,(?:_utf8mb4)?\\?'\$\.\\?"fr\\?"\\?'\)/u),
    ]);
    const indexes = await sql(context, engine, "read the indexes of the table", indexRead(engine));
    const parts = (index: string): string => text(pick(indexes.value, index, "parts"));
    const unique = (index: string): Json => pick(indexes.value, index, "unique") ?? null;
    context.expect(indexes.folder, [
      same("the table holds the primary key and one index per declared index, the crossInstance twin included", Object.keys(indexes.value ?? {}).sort(), [...built, "PRIMARY"].sort()),
      same("the primary key is (_instance, _id)", parts("PRIMARY"), "_instance, _id"),
      same("a number index keys on its own column, led by _instance", parts("price"), "_instance, price"),
      same("a string index keys on its key column, led by _instance", parts("name"), `_instance, ${name}`),
      same("a crossInstance index has an unprefixed __g twin", parts("name__g"), name),
      same("a unique index is UNIQUE within the instance, over the exact key column", [unique("sku"), parts("sku")], [true, `_instance, ${sku}`]),
      same("the __g twin is never unique", unique("name__g"), false),
      engine.multiValuedIndex
        ? has("a multi index over a string array is multi-valued, CHAR(512) ARRAY", parts("tags"), /^_instance, cast\(json_extract\(`tags`,.*\) as char\(512\) array\)$/u)
        : has("registration leaves a multi index out and says the engine has none", await logs(session), /this engine has no multi-valued index for the elements of 'tags'/u),
      has("a dotted index field below an object field keys on the nested path's value key, its kind and text then its number", parts("titleFr"), /^_instance, __k_title_fr_[0-9a-f]+, __k_title_fr_[0-9a-f]+$/u),
      has("each index is signed in its comment", text(pick(indexes.value, "price", "comment")), /^antelopejs:1:btree:_instance,price$/u),
    ]);
    const registry = await sql(
      context,
      engine,
      "read the instance registry",
      `SELECT JSON_ARRAYAGG(instance_id) FROM (SELECT instance_id FROM __antelope_instances WHERE schema_id = 'verify-layout' ORDER BY instance_id) r`,
    );
    context.expect(registry.folder, [same("__antelope_instances records each created instance", registry.value, ["a", "b"])]);
    await instances(session, engine);
    await close(session);
  },
});

async function instances(session: Session, engine: Engine): Promise<void> {
  const { context } = session;
  const result = await session.run(
    "write a duplicate key, read across instances and destroy one",
    `const schema = new Schema("verify-layout", ${LAYOUT});
const out = {};
try { await schema.instance("a").table("items").insert({ _id: "i3", name: "chair", sku: "S1" }).run(); out.duplicate = "stored"; } catch (error) { out.duplicate = error.name; }
out.crossCount = await schema.instance(db.CROSS_INSTANCE).table("items").count().run();
out.aCount = await schema.instance("a").table("items").count().run();
out.namedCarriesInstance = Object.hasOwn((await schema.instance("a").table("items").get("i1").run()) ?? {}, "_instance");
try { await schema.createInstance("x".repeat(129)).run(); out.longInstance = "created"; } catch (error) { out.longInstance = String(error.message); }
await schema.destroyInstance("b").run();
out.afterDestroy = (await schema.listInstances().run()).sort();
return out;`,
  );
  context.expect(result.folder, [answered(result)], { critical: true });
  context.expect(result.folder, [
    sees("a unique key taken in the same instance throws DuplicateKeyError", part(result, "duplicate"), "DuplicateKeyError"),
    sees("a CROSS_INSTANCE read sees the rows of every instance", part(result, "crossCount"), 3),
    sees("a scoped read sees only its instance", part(result, "aCount"), 2),
    sees("a document of a named instance carries _instance", part(result, "namedCarriesInstance"), true),
    has("an instance id over 128 characters is refused with the limit", text(pick(result.value, "longInstance")), /longer than 128 characters/u),
    sees("destroyInstance removes the instance", part(result, "afterDestroy"), ["a"]),
  ]);
  const rows = await sql(
    context,
    engine,
    "read the rows left after destroyInstance",
    `SELECT JSON_OBJECT('instances', (SELECT JSON_ARRAYAGG(i) FROM (SELECT DISTINCT _instance AS i FROM \`${TABLE}\`) d), 'table', (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'verify' AND TABLE_NAME = '${TABLE}'))`,
  );
  context.expect(rows.folder, [same("destroyInstance deletes the instance's rows and keeps the table", rows.value, { instances: ["a"], table: 1 })]);
}

const V1 = `{ notes: { fields: { title: "string" }, indexes: {} } }`;
const V2 = `{ notes: { fields: { title: "string", rank: "number" }, indexes: {} } }`;
const V3 = `{ notes: { fields: { rank: "string" }, indexes: {} } }`;

async function register(context: JourneyContext, engine: Engine, label: string, definition: string, migrations: string): Promise<{ session: Session; read: Awaited<ReturnType<Session["run"]>> }> {
  const session = await open(context, { ...ownedConfig(server(context, engine)), migrations });
  const read = await session.run(
    label,
    `const schema = new Schema("verify-migrate", ${definition});
try { const notes = schema.instance().table("notes"); return { row: await notes.get("r1").run(), kept: await notes.get("r2").run() }; } catch (error) { return { refused: String(error && error.message) }; }`,
  );
  context.expect(read.folder, [answered(read)], { critical: true });
  return { session, read };
}

function columns(context: JourneyContext, engine: Engine, label: string, row: string): ReturnType<typeof sql> {
  return sql(
    context,
    engine,
    label,
    `SELECT JSON_OBJECT('columns', (SELECT JSON_OBJECTAGG(COLUMN_NAME, JSON_OBJECT('type', COLUMN_TYPE, 'comment', COLUMN_COMMENT)) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'verify' AND TABLE_NAME = 'verify-migrate__notes' AND COLUMN_NAME IN ('title', 'rank')), 'row', (SELECT JSON_OBJECT(${row}) FROM \`verify-migrate__notes\` WHERE _id = 'r1'))`,
  );
}

export const migrations = (engine: Engine): Journey => ({
  title: "a new field adds its column and moves stored values out of _extra, a changed type is refused under safe and altered under destructive, which also drops an undeclared column",
  entryPoint: "the schema a consumer module declares, changed between two runs of `ajs project dev`, with `migrations` in the module's config",
  async run(context) {
    const first = await open(context, ownedConfig(server(context, engine)));
    const seeded = await first.run(
      "store a row with an undeclared field",
      `const schema = new Schema("verify-migrate", ${V1});
await schema.instance().table("notes").insert([{ _id: "r1", title: "x", rank: 5 }, { _id: "r2", title: "y", rank: "high" }]).run();
return "stored";`,
    );
    context.expect(seeded.folder, [answered(seeded)], { critical: true });
    await close(first);

    const second = await register(context, engine, "declare rank and read the row", V2, "safe");
    context.expect(second.read.folder, [
      sees("the row reads back with rank from its column", part(second.read, "row"), { _id: "r1", rank: 5, title: "x" }),
      sees("a stored rank the double column cannot hold reads back as absent, since the declared column wins", part(second.read, "kept"), { _id: "r2", title: "y" }),
    ]);
    const left = await sql(context, engine, "read the row whose rank stayed in _extra", "SELECT JSON_OBJECT('rank', `rank`, '_extra', _extra) FROM `verify-migrate__notes` WHERE _id = 'r2'");
    context.expect(left.folder, [same("the value the column cannot hold stays in _extra, and the column is NULL", left.value, { _extra: { rank: "high" }, rank: null })]);
    const added = await columns(context, engine, "read the columns after declaring rank", "'_extra', _extra, 'rank', `rank`, 'title', title");
    context.expect(added.folder, [
      same("rank is a double column holding 5 with its pending mark cleared, and _extra no longer holds it", added.value, {
        columns: { rank: { comment: "", type: "double" }, title: { comment: "", type: "longtext" } },
        row: { _extra: {}, rank: 5, title: "x" },
      }),
    ]);
    await close(second.session);

    const third = await register(context, engine, "declare rank as a string under safe", V3, "safe");
    const said = `${text(pick(third.read.value, "refused"))}\n${await logs(third.session)}`;
    context.expect(third.read.folder, [
      has("safe refuses the changed type and names the column", said, /Column 'rank' on 'verify-migrate__notes' is double but the schema declares longtext; set migrations: "destructive" to alter it/u),
      { name: "no read of the refused schema answers", pass: pick(third.read.value, "row") === undefined, detail: JSON.stringify(third.read.value ?? null) },
    ]);
    await close(third.session);

    const fourth = await register(context, engine, "declare rank as a string under destructive", V3, "destructive");
    context.expect(fourth.read.folder, [sees("the row reads back with rank as text", part(fourth.read, "row"), { _id: "r1", rank: "5" })]);
    const altered = await columns(context, engine, "read the columns after the destructive migration", "'_extra', _extra, 'rank', `rank`");
    context.expect(altered.folder, [
      same("rank is now longtext and the undeclared title column is dropped", altered.value, { columns: { rank: { comment: "", type: "longtext" } }, row: { _extra: {}, rank: "5" } }),
    ]);
    await close(fourth.session);
  },
});
