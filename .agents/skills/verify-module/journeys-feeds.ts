import type { Journey, JourneyContext } from "@antelopejs/tooling-configs/verify";

import { pick } from "./json.ts";
import { answered, client, close, open, ownedConfig, part, same, sees, seed, server, sql, type Engine } from "./session.ts";

const DOCS = `new Schema("verify-feeds", { docs: { fields: { title: "string", price: "number" }, indexes: {} } })`;

const TABLE = "verify-feeds__docs";

/** Waits, inside the container, until watching the table has installed its row triggers, so the writes after it reach the log the feeds read. */
async function triggersInstalled(context: JourneyContext, engine: Engine): Promise<void> {
  const query = `SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = 'verify' AND EVENT_OBJECT_TABLE = '${TABLE}'`;
  const check = [...client(engine, "verify"), `"${query}"`].join(" ");
  const waited = await context.native("wait for the feed's triggers", engine.service, [
    "sh",
    "-c",
    `for i in $(seq 100); do n=$(${check}); [ "$n" -gt 0 ] && exit 0; sleep 0.1; done; exit 1`,
  ]);
  context.expect(waited.folder, [{ name: "watching the table installed its triggers", pass: waited.exitCode === 0, detail: waited.stdout.trim() }], { critical: true });
}

export const changeFeeds = (engine: Engine): Journey => ({
  title: "a feed delivers added, modified and removed events in order with the documented oldValue and newValue, a write made with the mysql client included, and a filtered feed shows a row leaving its filter",
  entryPoint: "`table.changes()` and `table.filter(...).changes()` iterated by a consumer module while it and the mysql client write",
  async run(context) {
    const session = await open(context, ownedConfig(server(context, engine)));
    const opened = await session.run(
      "open two feeds",
      `const docs = ${DOCS}.instance().table("docs");
await docs.insert({ _id: "seed", title: "seed", price: 1 }).run();
globalThis.verifyFeeds = { all: [], cheap: [], errors: [] };
const shape = (c) => ({ type: c.changeType, hasOld: Object.hasOwn(c, "oldValue"), hasNew: Object.hasOwn(c, "newValue"), old: c.oldValue ? c.oldValue.title : null, new: c.newValue ? c.newValue.title : null });
const follow = async (feed, into) => { for await (const c of feed) if ((c.newValue ?? c.oldValue)._id !== "seed") into.push(shape(c)); };
follow(docs.changes(), globalThis.verifyFeeds.all).catch((e) => globalThis.verifyFeeds.errors.push(String(e && e.message)));
follow(docs.filter((d) => d.key("price").lt(100)).changes(), globalThis.verifyFeeds.cheap).catch((e) => globalThis.verifyFeeds.errors.push(String(e && e.message)));
return "opened";`,
    );
    context.expect(opened.folder, [answered(opened)], { critical: true });
    await triggersInstalled(context, engine);
    const written = await session.run(
      "write through the module",
      `const docs = ${DOCS}.instance().table("docs");
await waitFor(500);
await docs.insert({ _id: "a", title: "added", price: 10 }).run();
await docs.get("a").update({ title: "modified" }).run();
await docs.get("a").update({ price: 500 }).run();
await docs.get("a").delete().run();
return "written";`,
    );
    context.expect(written.folder, [answered(written)], { critical: true });
    await seed(context, engine, "write a row with the mysql client while the feeds are open", `INSERT INTO \`${TABLE}\` (_id, _instance, title, price) VALUES ('ext', '', 'from the client', 5)`);
    const read = await session.run(
      "read what the feeds delivered",
      `const feeds = globalThis.verifyFeeds;
for (let i = 0; i < 40 && (feeds.all.length < 5 || feeds.cheap.length < 4) && feeds.errors.length === 0; i++) await waitFor(100);
return feeds;`,
    );
    context.expect(read.folder, [answered(read)], { critical: true });
    context.expect(read.folder, [
      sees("no feed ended with an error", part(read, "errors"), []),
      sees("the feed delivers every write in order, the client's one included, with oldValue absent on added and newValue absent on removed", part(read, "all"), [
        { hasNew: true, hasOld: false, new: "added", old: null, type: "added" },
        { hasNew: true, hasOld: true, new: "modified", old: "added", type: "modified" },
        { hasNew: true, hasOld: true, new: "modified", old: "modified", type: "modified" },
        { hasNew: false, hasOld: true, new: null, old: "modified", type: "removed" },
        { hasNew: true, hasOld: false, new: "from the client", old: null, type: "added" },
      ]),
      sees("the filtered feed shows the row leaving the filter as modified and then nothing for the removal outside it", part(read, "cheap"), [
        { hasNew: true, hasOld: false, new: "added", old: null, type: "added" },
        { hasNew: true, hasOld: true, new: "modified", old: "added", type: "modified" },
        { hasNew: true, hasOld: true, new: "modified", old: "modified", type: "modified" },
        { hasNew: true, hasOld: false, new: "from the client", old: null, type: "added" },
      ]),
    ]);
    const log = await sql(
      context,
      engine,
      "read the change log and the table's triggers",
      `SELECT JSON_OBJECT(
  'log', (SELECT JSON_ARRAYAGG(t) FROM (SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'verify' AND TABLE_NAME LIKE '\\_\\_antelope\\_change%' ORDER BY TABLE_NAME) l),
  'triggers', (SELECT JSON_ARRAYAGG(e) FROM (SELECT CONCAT(ACTION_TIMING, ' ', EVENT_MANIPULATION, ' ', IF(TRIGGER_NAME REGEXP '^ajs_chg_[0-9a-f]{16}_[iud]$', 'ajs_chg_<signature>', TRIGGER_NAME)) AS e FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = 'verify' AND EVENT_OBJECT_TABLE = '${TABLE}' ORDER BY EVENT_MANIPULATION) g))`,
    );
    context.expect(log.folder, [
      same("registration created the change log, its clock and its reaped high-waters", pick(log.value, "log"), ["__antelope_change_clock", "__antelope_change_reaped", "__antelope_changes"]),
      same("watching the table installed one AFTER row trigger per operation, named ajs_chg_ and the signature of its body", pick(log.value, "triggers"), [
        "AFTER INSERT ajs_chg_<signature>",
        "AFTER UPDATE ajs_chg_<signature>",
        "AFTER DELETE ajs_chg_<signature>",
      ]),
    ]);
    await close(session);
  },
});
