import type { Journey, VerifyConfig } from "@antelopejs/tooling-configs/verify";

import { CLIENT, READER } from "./client.ts";
import { catalogDescribe, catalogRefused } from "./journeys-catalog.ts";
import { externalReadWrite, externalRegistration } from "./journeys-external.ts";
import { changeFeeds } from "./journeys-feeds.ts";
import { configOptions, configRefused } from "./journeys-module.ts";
import { readQueries } from "./journeys-reads.ts";
import { migrations, storageLayout } from "./journeys-schemas.ts";
import { insertValues, updateReplaceDelete } from "./journeys-writes.ts";
import { DATABASE, ENGINES, MYSQL, ownedConfig, type Engine } from "./session.ts";

const RESET = [
  `DROP DATABASE IF EXISTS \`${DATABASE}\``,
  `DROP DATABASE IF EXISTS \`${CLIENT}\``,
  `DROP USER IF EXISTS '${READER}'@'%'`,
  `CREATE DATABASE \`${DATABASE}\``,
].join("; ");

const ON_EVERY_ENGINE = {
  "config-options": configOptions,
  "storage-layout": storageLayout,
  migrations,
  "insert-values": insertValues,
  "update-replace-delete": updateReplaceDelete,
  "read-queries": readQueries,
  "change-feeds": changeFeeds,
  "external-read-write": externalReadWrite,
  "external-registration": externalRegistration,
  "catalog-describe": catalogDescribe,
  "catalog-refused": catalogRefused,
} satisfies Record<string, (engine: Engine) => Journey>;

function journeyId(id: string, engine: Engine): string {
  return engine === MYSQL ? id : `${id}-${engine.service}`;
}

const FORMAL_CHANGE_FEED_DELIVERY = ".agents/skills/formal-change-feed-delivery";

const config: VerifyConfig = {
  doors: {
    data: {
      globs: [
        "src/dialect/mysql/ddl.ts",
        "src/implementations/database/convergence.ts",
        "src/implementations/database/migrate-tables.ts",
        "src/implementations/database/migrate-indexes.ts",
        "src/implementations/database/instances.ts",
        "src/implementations/database/registry.ts",
        "src/implementations/database/transaction.ts",
        "src/implementations/database/writes*.ts",
        "src/implementations/database/external-writes.ts",
        "src/implementations/database/external-insert.ts",
        "src/implementations/database/external-write-shared.ts",
      ],
      funnels: [
        "src/dialect/mysql/ddl.ts",
        "src/implementations/database/migrate-tables.ts",
        "src/implementations/database/writes.ts",
        "src/implementations/database/external-writes.ts",
      ],
      why: "these modules run the DDL that converges a table (a destructive migration retypes or drops columns), write and delete rows, and wipe an instance: a change here can lose stored rows or write into a client's external database",
    },
    format: {
      globs: [
        "src/dialect/mysql/session.ts",
        "src/dialect/mysql/sql-core.ts",
        "src/implementations/database/identifier.ts",
        "src/implementations/database/fields.ts",
        "src/implementations/database/types.ts",
        "src/implementations/database/plan.ts",
        "src/implementations/database/paths.ts",
        "src/implementations/database/registry.ts",
        "src/implementations/database/convergence.ts",
        "src/implementations/database/value.ts",
        "src/implementations/database/coerce.ts",
        "src/implementations/database/utils.ts",
      ],
      funnels: [],
      why: "the physical table name `<schemaPrefix><schemaId>__<tableId>` and its 64-character cut, the field-type to column-type table, the utf8mb4_0900_bin collation, the _id, _instance and _extra columns and their widths, the key columns `__k_…` and their widths, the index names and the `antelopejs:1:` comments on tables, columns and indexes, and the `__antelope_instances` registry are the layout every stored table already has: an upgrade that changes them stops finding what the last release wrote",
    },
    contract: {
      globs: ["package.json", "src/config.ts", "src/index.ts"],
      funnels: [],
      why: "the config keys (`mode`, `url`, `pool`, `dialect`, `schemaPrefix`, `migrations`, the cursor and change options, `catalog`), the `pool` options the module refuses, `antelopeJs.defaultConfig` and the implemented interfaces",
    },
    outbound: null,
    exposure: null,
    publish: {
      globs: ["package.json", ".release-it.json", "changelogen.config.json", ".github/workflows/release.yml"],
      funnels: [],
      why: "the package name and release workflow claim @antelopejs/mysql on npm",
    },
  },
  userFacing: ["src/*.ts", "src/dialect/**", "src/implementations/**"],
  shared: [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "tsconfig.*.json",
    "antelope-lock/**",
    "src/interfaces/**",
    "src/interface/**",
    "src/dialect/mysql/flavour.ts",
    "src/dialect/mariadb/**",
  ],
  services: Object.fromEntries(
    ENGINES.map((engine) => [
      engine.service,
      {
        image: engine.image,
        port: 3306,
        env: engine.env,
        ready: [engine.client, "-h127.0.0.1", "-uroot", "-N", "-e", "SELECT 1"],
        reset: [engine.client, "-uroot", "-e", RESET],
      },
    ]),
  ),
  moduleConfig(services) {
    const found = services.find((service) => service.name === MYSQL.service);
    return ownedConfig({ name: MYSQL.service, container: found?.container ?? "", host: found?.host ?? "127.0.0.1", port: found?.port ?? 3306 });
  },
  journeys: {
    "config-refused": configRefused,
    ...Object.fromEntries(ENGINES.flatMap((engine) => Object.entries(ON_EVERY_ENGINE).map(([id, journey]) => [journeyId(id, engine), journey(engine)]))),
  },
  formal: [
    {
      name: "formal-change-feed-delivery",
      covers: [
        "src/implementations/database/feeds.ts",
        "src/implementations/database/feed-poll.ts",
        "src/implementations/database/sequencer.ts",
        "src/implementations/database/reaper.ts",
        "src/implementations/database/change-loop.ts",
        "src/dialect/mysql/capture.ts",
      ],
      files: [`${FORMAL_CHANGE_FEED_DELIVERY}/**`],
      command: ["node", `${FORMAL_CHANGE_FEED_DELIVERY}/check.mjs`, "--full"],
      baseCommand: ["node", `${FORMAL_CHANGE_FEED_DELIVERY}/check.mjs`],
      violation: /^(?:finding|BROKEN|HOLDS) +(\w+)/gm,
      passing: /(?<=^holds +(?:\w+, )*)(\w+)(?=,| \()/gm,
      behaviour: { kind: "emit" },
    },
  ],
};

export default config;
