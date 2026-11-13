import { has, type Journey } from "@antelopejs/tooling-configs/verify";

import { parseJson, pick } from "./json.ts";
import { answered, close, open, orderedArray, path, same, sees, server, sql, urlOf, type Engine, type ModuleConfig } from "./session.ts";

/** A server nothing answers on, so a refusal that regressed past validation can never reach a developer's local database. */
const DEAD = "mysql://root@127.0.0.1:1/verify";

const REFUSALS: [string, ModuleConfig, RegExp][] = [
  ["an unknown mode", { mode: "shared", url: DEAD }, /mode must be one of owned, external, received shared/u],
  ["a cursorBatchSize of zero", { url: DEAD, cursorBatchSize: 0 }, /cursorBatchSize must be a positive safe integer, received 0/u],
  ["a fractional cursorBatchSize", { url: DEAD, cursorBatchSize: 1.5 }, /cursorBatchSize must be a positive safe integer, received 1\.5/u],
  ["a negative changeRetentionMs", { url: DEAD, changeRetentionMs: -5 }, /changeRetentionMs must be a positive safe integer, received -5/u],
  ["a negative statementTimeoutMs", { url: DEAD, statementTimeoutMs: -1 }, /statementTimeoutMs must be a non-negative safe integer, received -1/u],
  ["an unknown dialect", { url: DEAD, dialect: "postgres" }, /dialect must be "auto" or a supported engine, received postgres/u],
  ["a pool option the module sets itself", { url: DEAD, pool: { timezone: "local" } }, /pool\.timezone cannot be set: the module sets it itself/u],
  ["an external instance without a url", { mode: "external" }, /mode "external" needs a non-empty config\.url/u],
  [
    "an external instance with owned-only options",
    { mode: "external", url: "mysql://root@127.0.0.1:1/sales", schemaPrefix: "app_", migrations: "destructive" },
    /schemaPrefix, migrations cannot be set with mode "external"/u,
  ],
  ["an owned instance whose server does not answer", { url: DEAD }, /connect ECONNREFUSED 127\.0\.0\.1:1/u],
];

export const configRefused: Journey = {
  title: "the module refuses to start on a config docs/configuration.md and docs/external-mode.md exclude, and says why",
  entryPoint: "`ajs project dev` with an unusable `config` in antelope.config.ts",
  async run(context) {
    const cli = path(context.repo, "node_modules/@antelopejs/core/dist/core/cli/index.js");
    for (const [label, config, message] of REFUSALS) {
      const project = context.fixture({ moduleConfig: config });
      const started = await context.command(`ajs project dev with ${label}`, "node", [cli, "project", "dev"], { cwd: project, timeoutMs: 60_000 });
      context.expect(started.folder, [
        {
          name: `the project exited on its own with a failure code with ${label}`,
          pass: started.exitCode !== null && started.exitCode !== 0 && started.signal === null,
          detail: `exit ${String(started.exitCode)}, signal ${String(started.signal)}`,
        },
        has(`the refusal says why (${label})`, started.stdout + started.stderr, message),
      ]);
    }
  },
};

const ROUND_TRIP = `const schema = new Schema("verify-config", { notes: { fields: { title: "string" }, indexes: {} } });
const notes = schema.instance().table("notes");
await notes.insert({ _id: "n1", title: "stored" }).run();
return (await notes.get("n1").run()).title;`;

export const configOptions = (engine: Engine): Journey => ({
  title: "the default config points at localhost, a pool option the url does not set reaches every connection, every connection runs the session pin, and schemaPrefix prefixes every table name",
  entryPoint: "`url`, `pool` and `schemaPrefix` in the module's config in antelope.config.ts",
  async run(context) {
    const manifest = await context.command("read the module's package.json, where the default configuration `ajs project modules add` writes lives", "cat", [
      path(context.repo, "package.json"),
    ]);
    context.expect(manifest.folder, [
      same("the default configuration is the documented url in safe mode", pick(parseJson(manifest.stdout), "antelopeJs", "defaultConfig"), {
        migrations: "safe",
        url: "mysql://root@localhost:3306/antelopejs",
      }),
    ]);
    const merged = await open(context, { url: urlOf(server(context, engine)), pool: { connectAttributes: { program_name: "verify-pool" } }, schemaPrefix: "app_" });
    const result = await merged.run("round trip with a pool option and a schemaPrefix", ROUND_TRIP);
    context.expect(result.folder, [answered(result), sees("the document written through the module reads back", result, "stored")]);
    const stored = await sql(
      context,
      engine,
      "read the prefixed table",
      `SELECT ${orderedArray("JSON_QUOTE(TABLE_NAME)", "CAST(TABLE_NAME AS BINARY)", "information_schema.TABLES WHERE TABLE_SCHEMA = 'verify' AND TABLE_NAME LIKE '%verify-config%'")}`,
    );
    context.expect(stored.folder, [same("the table is stored as <schemaPrefix><schemaId>__<tableId> in the url's database, and only there", stored.value, ["app_verify-config__notes"])]);
    const dialect = await sql(
      context,
      engine,
      "read the collation and the _extra column type the dialect chose",
      `SELECT JSON_ARRAY((SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'verify' AND TABLE_NAME = 'app_verify-config__notes'), (SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'verify' AND TABLE_NAME = 'app_verify-config__notes' AND COLUMN_NAME = '_extra'))`,
    );
    context.expect(dialect.folder, [same(`the module detected ${engine.name}: the table is ${engine.collation} and _extra ${engine.documentType}`, dialect.value, [engine.collation, engine.documentType])]);
    const pinned = await sql(context, engine, "read the session pin of the module's connections", engine.pin);
    context.expect(pinned.folder, [
      same("every connection carrying pool.connectAttributes runs the session pin: binary NO PAD collation, UTC, English messages, strict mode", pinned.value, [
        ["collation_connection", engine.collation],
        ["lc_messages", "en_US"],
        ["sql_mode", "STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION"],
        ["time_zone", "+00:00"],
      ]),
    ]);
    await close(merged);
  },
});
