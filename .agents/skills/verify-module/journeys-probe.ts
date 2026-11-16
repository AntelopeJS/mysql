import type { Journey } from "@antelopejs/tooling-configs/verify";

import { parseJson, pick, type Json } from "./json.ts";
import { DATABASE, path, same, seed, server, type Engine } from "./session.ts";

/** The accounts the probe journey creates, dropped again by the service's `reset`. */
export const PROBE_USERS = ["probe_reader", "probe_builder", "probe_locked"];

const SECRET = "probe-secret";

const SETUP = `CREATE DATABASE probe_shop;
CREATE TABLE probe_shop.orders (id INT PRIMARY KEY);
CREATE USER 'probe_reader'@'%' IDENTIFIED BY '${SECRET}';
GRANT SELECT ON probe_shop.* TO 'probe_reader'@'%';
GRANT SELECT ON ${DATABASE}.* TO 'probe_reader'@'%';
CREATE USER 'probe_builder'@'%' IDENTIFIED BY '${SECRET}';
GRANT SELECT, CREATE ON ${DATABASE}.* TO 'probe_builder'@'%';
CREATE USER 'probe_locked'@'%' IDENTIFIED BY '${SECRET}';
GRANT SELECT ON probe_shop.* TO 'probe_locked'@'%';`;

const CALL = `const { probe } = require(process.argv[1]);
const controller = new AbortController();
probe({ url: process.argv[2], timeoutMs: 10000, signal: controller.signal }).then((answer) => console.log(JSON.stringify(answer)));`;

export const probeAccess = (engine: Engine): Journey => ({
  title: "the probe built to dist/probe answers what each account may do on a live server, and says why it was turned down or not answered",
  entryPoint: "`probe({ url, timeoutMs, signal })` from `@antelopejs/mysql/dist/probe`, loaded by a plain Node process outside `ajs`",
  async run(context) {
    await seed(context, engine, "create the shop database and four accounts", SETUP, "mysql");
    const endpoint = server(context, engine);
    const authority = `${endpoint.host}:${String(endpoint.port)}`;
    const entry = path(context.repo, "dist/probe.js");
    const ask = async (label: string, url: string) => {
      const run = await context.command(`probe ${label}`, "node", ["-e", CALL, entry, url], { timeoutMs: 30_000 });
      context.expect(run.folder, [{ name: `the probe process printed an answer (${label})`, pass: run.exitCode === 0, detail: run.stderr.slice(-300) }], { critical: true });
      return { folder: run.folder, answer: parseJson(run.stdout.trim().split("\n").at(-1) ?? "") };
    };
    const of = (answer: Json | undefined, ...keys: string[]) => keys.map((key) => pick(answer, key) ?? null);
    const account = (user: string, database: string, secret = SECRET) => `mysql://${user}:${secret}@${authority}/${database}`;

    const reader = await ask("an account that may only SELECT", account("probe_reader", "probe_shop"));
    context.expect(reader.folder, [
      same("a SELECT-only account reads and does not write", of(reader.answer, "outcome", "canRead", "canWrite"), ["signed-in", true, false]),
    ]);

    const empty = await ask("an account that may only SELECT, on an empty database", account("probe_reader", DATABASE));
    context.expect(empty.folder, [
      same("an account that sees no relation reads and may not write", of(empty.answer, "canRead", "canWrite"), [true, false]),
    ]);

    const builder = await ask("an account that may CREATE in an empty database", account("probe_builder", DATABASE));
    context.expect(builder.folder, [
      same("the right to create tables counts as write access in an empty database", of(builder.answer, "canRead", "canWrite"), [true, true]),
    ]);
    const stored = await context.native("list what the probe left in the empty database", engine.service, [
      engine.client, "-uroot", "-N", "-B", DATABASE, "-e", "SHOW TABLES",
    ]);
    context.expect(stored.folder, [answeredStatement(stored.exitCode), same("the probe created no table", stored.stdout.trim(), "")]);

    const noDatabase = await ask("a url with no database", `mysql://probe_reader:${SECRET}@${authority}/`);
    context.expect(noDatabase.folder, [same("a url with no database is unreadable", of(noDatabase.answer, "outcome", "unreadable"), ["signed-in", "no-database-named"])]);

    const wrong = await ask("a wrong password", account("probe_reader", "probe_shop", "not-the-secret"));
    context.expect(wrong.folder, [same("a wrong password is refused as credentials", of(wrong.answer, "outcome", "refusal"), ["refused", "credentials"])]);

    const missing = await ask("no password", `mysql://probe_reader@${authority}/probe_shop`);
    context.expect(missing.folder, [same("no password is refused as sign-in-required", of(missing.answer, "outcome", "refusal"), ["refused", "sign-in-required"])]);

    const dead = await ask("a port nothing listens on", "mysql://root@127.0.0.1:1/verify");
    context.expect(dead.folder, [same("a dead port is unreachable", pick(dead.answer, "outcome"), "unreachable")]);
  },
});

function answeredStatement(exitCode: number | null) {
  return { name: "the listing ran", pass: exitCode === 0, detail: `exit ${String(exitCode)}` };
}
