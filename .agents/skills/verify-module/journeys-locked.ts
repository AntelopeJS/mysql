import { has, type Journey, type JourneyContext } from "@antelopejs/tooling-configs/verify";

import { pick, text } from "./json.ts";
import { answered, close, logs, open, ownedConfig, same, sees, seed, server, sql, DATABASE, type Answer, type Engine, type Session } from "./session.ts";

const DEFINITION = (indexes: string): string => `{ items: { fields: { price: "number", sku: "string" }, indexes: ${indexes} } }`;
const BARE = DEFINITION("{}");
const UNIQUE = DEFINITION(`{ price: { unique: true } }`);
const TABLE = "verify-locked__items";
const FLAG = "/tmp/verify-locked-commit";

const REFUSAL =
  /^Write refused: unique index 'price' on 'verify-locked\.items' is not built, because a transaction holds the table \(.+\), so a write that adds rows or sets price could store the duplicate it exists to refuse\. It is built once that transaction ends, and the write can be run again then$/u;

const ITEMS = `const items = (globalThis.lockedItems ??= new Schema("verify-locked", ${UNIQUE}).instance().table("items"));`;
const SETTLE = `const settle = (promise, ok) => Promise.race([promise.then(ok, (error) => String(error.message)), waitFor(4000).then(() => "pending")]);`;

function holdScript(engine: Engine): string {
  const statements = [`echo 'START TRANSACTION;'`, `echo 'SELECT _id FROM \`${TABLE}\` LIMIT 1;'`, `i=0`, `while [ ! -f ${FLAG} ] && [ $i -lt 150 ]; do sleep 1; i=$((i+1)); done`, `echo 'COMMIT;'`];
  return `rm -f ${FLAG}; ( ${statements.join("; ")} ) | ${engine.client} -uroot -N -B ${DATABASE} > /tmp/verify-locked-holder.out 2>&1`;
}

async function pause(context: JourneyContext, seconds: number): Promise<void> {
  await context.command(`wait ${String(seconds)} s`, "sleep", [String(seconds)]);
}

async function settled(session: Session, name: string, body: string): Promise<Answer> {
  let answer = await session.run(name, body);
  for (let tries = 0; tries < 8 && answer.ok && answer.value === "pending"; tries += 1) {
    await pause(session.context, 2);
    answer = await session.run(`${name} (again)`, body);
  }
  return answer;
}

async function loggedWithin(session: Session, pattern: RegExp, attempts: number): Promise<string> {
  let output = await logs(session);
  for (let tries = 0; tries < attempts && !pattern.test(output); tries += 1) {
    await pause(session.context, 3);
    output = await logs(session);
  }
  return output;
}

const rows = (engine: Engine, context: JourneyContext, name: string) =>
  sql(context, engine, name, `SELECT COALESCE(JSON_ARRAYAGG(JSON_ARRAY(_id, price, sku)), JSON_ARRAY()) FROM (SELECT _id, price, sku FROM \`${TABLE}\` ORDER BY _id) r`);

const priceIndex = (engine: Engine, context: JourneyContext, name: string) =>
  sql(context, engine, name, `SELECT COALESCE(JSON_ARRAYAGG(NON_UNIQUE), JSON_ARRAY()) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = '${DATABASE}' AND TABLE_NAME = '${TABLE}' AND INDEX_NAME = 'price'`);

async function showIndex(engine: Engine, context: JourneyContext, name: string): Promise<void> {
  const shown = await context.native(name, engine.service, [engine.client, "-uroot", "-B", DATABASE, "-e", `SHOW INDEX FROM \`${TABLE}\``]);
  context.expect(shown.folder, [{ name: "SHOW INDEX ran", pass: shown.exitCode === 0, detail: shown.stderr.slice(-300) }], { critical: true });
}

async function holders(engine: Engine, context: JourneyContext, name: string) {
  return sql(context, engine, name, `SELECT JSON_ARRAY(COUNT(*)) FROM information_schema.INNODB_TRX WHERE trx_started < NOW() AND trx_query IS NULL`);
}

export const lockedUniqueIndex = (engine: Engine): Journey => ({
  title: "a unique index whose build a long transaction holds off refuses the writes it would check once the phase gives up, keeps reads and other updates working, and is built once the transaction ends",
  entryPoint: "`unique: true` added to a schema whose table a separate client holds in an open transaction, then written from a consumer module",
  async run(context) {
    const first = await open(context, ownedConfig(server(context, engine)));
    const created = await first.run("create the table", `await new Schema("verify-locked", ${BARE}).instance().table("items").count().run(); return "created";`);
    context.expect(created.folder, [answered(created)], { critical: true });
    await close(first);
    await seed(context, engine, "store one row", `INSERT INTO \`${TABLE}\` (_id, _instance, sku, price) VALUES ('seed', '', 'sku-seed', 1)`);

    const container = server(context, engine).container;
    const started = await context.command("start a client that holds the table in an open transaction", "docker", ["exec", "-d", container, "sh", "-c", holdScript(engine)]);
    context.expect(started.folder, [{ name: "the holding client started", pass: started.exitCode === 0, detail: started.stderr }], { critical: true });
    try {
      await pause(context, 2);
      const held = await holders(engine, context, "read the open transactions");
      context.expect(held.folder, [same("one transaction other than the harness's is open", held.value, [1])]);

      const app = await open(context, ownedConfig(server(context, engine)));
      const registered = await app.run("register the schema with the unique index and read", `${ITEMS}\n${SETTLE}\nreturn await settle(items.get("seed").run(), (row) => row?.price ?? null);`);
      context.expect(registered.folder, [answered(registered)], { critical: true });

      const given = await loggedWithin(app, /could not build unique index 'price'/u, 20);
      context.expect(registered.folder, [
        has("the index phase warns that the lock held the build off", given, /could not build unique index 'price': .*Inserts, and writes that set its fields, are refused until it is built: it is tried again until the transaction that holds the table ends/u),
      ]);

      const insert = await settled(app, "insert while the table is held", `${ITEMS}\n${SETTLE}\nreturn await settle(items.insert({ _id: "d", price: 7 }).run(), () => "stored");`);
      const setsOther = await settled(app, "update a field that is not indexed while the table is held", `${ITEMS}\n${SETTLE}\nreturn await settle(items.get("seed").update({ sku: "renamed" }).run(), () => "stored");`);
      const read = await settled(app, "read while the table is held", `${ITEMS}\n${SETTLE}\nreturn await settle(items.get("seed").run(), (row) => row?.price ?? null);`);
      context.expect(insert.folder, [has("an insert is refused, naming the index and the transaction", text(insert.value), REFUSAL)]);
      context.expect(setsOther.folder, [sees("an update of another field goes through", setsOther, "stored")]);
      context.expect(read.folder, [sees("a read answers", read, 1)]);
      const afterRefusal = await rows(engine, context, "read the rows the refused insert left");
      context.expect(afterRefusal.folder, [same("the refused insert stored nothing", afterRefusal.value, [["seed", 1, "renamed"]])]);
      const none = await priceIndex(engine, context, "read the price index while held");
      context.expect(none.folder, [same("no price index exists yet", none.value, [])]);
      await showIndex(engine, context, "SHOW INDEX while held");

      await pause(context, 8);
      let waits = 0;
      for (let sample = 0; sample < 8 && waits === 0; sample += 1) {
        const polled = await sql(context, engine, "look for a later pass waiting on the lock", `SELECT JSON_ARRAY(COUNT(*)) FROM information_schema.PROCESSLIST WHERE INFO LIKE 'ALTER TABLE \`${TABLE}\`%'`);
        waits = Number(pick(polled.value, 0));
        await pause(context, 1);
      }
      const later = await settled(app, "insert again after the first pass, still held", `${ITEMS}\n${SETTLE}\nreturn await settle(items.insert({ _id: "g", price: 7 }).run(), () => "stored");`);
      context.expect(later.folder, [
        { name: "a later pass of the phase is waiting on the metadata lock", pass: waits > 0, detail: `ALTER statements waiting: ${String(waits)}` },
        has("a later insert is still refused", text(later.value), REFUSAL),
      ]);

      const committing = await context.native("the client commits", engine.service, ["sh", "-c", `touch ${FLAG}`]);
      context.expect(committing.folder, [{ name: "the commit was signalled", pass: committing.exitCode === 0, detail: committing.stderr }], { critical: true });
      await pause(context, 2);
      const released = await holders(engine, context, "read the open transactions after the commit");
      context.expect(released.folder, [same("no other transaction is open", released.value, [0])]);

      const built = await loggedWithin(app, /built unique index 'price' of 'verify-locked\.items' once the lock that held it off was released/u, 14);
      context.expect(released.folder, [has("the phase reports the index built once the lock was released", built, /built unique index 'price' of 'verify-locked\.items' once the lock that held it off was released/u)]);
      const index = await priceIndex(engine, context, "read the price index after the commit");
      context.expect(index.folder, [same("the unique price index exists", index.value, [0, 0])]);
      await showIndex(engine, context, "SHOW INDEX after the commit");

      const stored = await settled(app, "insert a fresh key once the index is built", `${ITEMS}\n${SETTLE}\nreturn await settle(items.insert({ _id: "e", price: 9 }).run(), () => "stored");`);
      const duplicate = await app.run(
        "insert the same key again",
        `${ITEMS}\ntry { await items.insert({ _id: "f", price: 9 }).run(); return "stored"; } catch (error) { return error.name; }`,
      );
      context.expect(stored.folder, [sees("a fresh key is stored", stored, "stored")]);
      context.expect(duplicate.folder, [sees("its duplicate throws DuplicateKeyError", duplicate, "DuplicateKeyError")]);
      await close(app);
      const final = await rows(engine, context, "read the stored rows");
      context.expect(final.folder, [same("exactly one row per key", final.value, [["e", 9, null], ["seed", 1, "renamed"]])]);
      const counts = await sql(context, engine, "count rows per price", `SELECT COALESCE(JSON_ARRAYAGG(JSON_ARRAY(price, n)), JSON_ARRAY()) FROM (SELECT price, COUNT(*) n FROM \`${TABLE}\` GROUP BY price ORDER BY price) r`);
      context.expect(counts.folder, [same("every price is stored once", counts.value, [[1, 1], [9, 1]])]);
    } finally {
      await context.native("release the holding client", engine.service, ["sh", "-c", `touch ${FLAG}`]);
    }
  },
});
