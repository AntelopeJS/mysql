import path from "node:path";
import { randomBytes } from "node:crypto";
import { type RowDataPacket, createConnection } from "mysql2/promise";
import { defineConfig } from "@antelopejs/interface-core/config";
import {
  MySqlContainer,
  type StartedMySqlContainer,
} from "@testcontainers/mysql";

import {
  CLIENT_DATABASE,
  CLIENT_USER,
  Fixture,
  READER_PASSWORD,
  ReaderGrants,
  WriterGrants,
} from "../test-external/fixture";
import { DetectDialect } from "../dialect";

const DEFAULT_IMAGE = "mysql:8.4";
const EXTERNAL_MODE = "external";
const DECORATORS_MODE = "decorators";
const REPOSITORY = path.resolve(__dirname, "..", "..");

/**
 * `owned` (unset), `external`, or `decorators`. The decorators suite runs from a wrapper module that
 * holds the decorators' build (`scripts/decorators.sh`), so its tests run in the decorators' own
 * module context and reach this repository as a second module, as a consumer's calls do.
 */
const MODE = process.env.MYSQL_TEST_MODE;

/**
 * The port `api` serves the decorators' routes on, which their `model` tests fetch from:
 * `DECORATORS_TEST_API_PORT`, a free port `scripts/decorators.sh` picks for each run unless the
 * caller sets one, so decorators suites on one machine run side by side.
 */
function ApiPort(): number {
  const raw = process.env.DECORATORS_TEST_API_PORT ?? "";
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65_535) {
    throw new Error(
      `DECORATORS_TEST_API_PORT must be a port from 1 to 65535, got "${raw}"; scripts/decorators.sh picks a free one`,
    );
  }
  return port;
}

/** The `api` module entry that serves the decorators' routes on `port`. */
function ApiModuleConfig(port: number) {
  return {
    source: { type: "local" as const, path: ApiModule() },
    config: {
      servers: [{ protocol: "http", host: "127.0.0.1", port }],
      publicBaseUrl: `http://127.0.0.1:${port}`,
    },
  };
}

/** The `@antelopejs/api` module the decorators' routes are served by, installed as a dev dependency. */
function ApiModule(): string {
  return path.dirname(
    require.resolve("@antelopejs/api/package.json", { paths: [REPOSITORY] }),
  );
}

const SUITE_DATABASE_PREFIX = "ajs_";
const SUITE_DATABASE_ENTROPY_BYTES = 6;

let container: StartedMySqlContainer | undefined;
let adminUrl: string | undefined;
let suiteDatabase: string | undefined;

interface ModuleSettings {
  url: string;
  mode?: string;
  catalog?: CatalogSettings;
}

interface CatalogSettings {
  enabled: boolean;
}

function moduleConfig(config: ModuleSettings) {
  const target = MODE === DECORATORS_MODE ? "mysql" : "local";
  return { modules: { [target]: { config } } };
}

/** The admin URL of the server under test: `MYSQL_TEST_URL`, or a container of `MYSQL_TEST_IMAGE`. */
async function AdminUrl(): Promise<string> {
  if (process.env.MYSQL_TEST_URL) {
    return process.env.MYSQL_TEST_URL;
  }
  container = await new MySqlContainer(
    process.env.MYSQL_TEST_IMAGE ?? DEFAULT_IMAGE,
  ).start();
  return container.getConnectionUri(true);
}

/** The engine the server under test runs, as the module's dialect detection names it. */
async function EngineOf(url: string) {
  const connection = await createConnection(url);
  try {
    const [rows] = await connection.query<RowDataPacket[]>(
      "SELECT VERSION() AS version",
    );
    return DetectDialect(String(rows[0]?.version));
  } finally {
    await connection.end();
  }
}

async function Run(url: string, statements: readonly string[]) {
  const connection = await createConnection(url);
  try {
    for (const statement of statements) {
      await connection.query(statement);
    }
  } finally {
    await connection.end();
  }
}

function WithDatabase(url: string, database: string, user?: string): string {
  const target = new URL(url);
  target.pathname = `/${database}`;
  if (user) {
    target.username = user;
    target.password = READER_PASSWORD;
  }
  return target.toString();
}

/** A database of the suite's own, so suites sharing one server never share state. */
async function SuiteDatabase(url: string): Promise<string> {
  suiteDatabase = `${SUITE_DATABASE_PREFIX}${randomBytes(SUITE_DATABASE_ENTROPY_BYTES).toString("hex")}`;
  await Run(url, [`CREATE DATABASE \`${suiteDatabase}\``]);
  return WithDatabase(url, suiteDatabase);
}

/**
 * Builds the client database as its owner would, and answers the URL of the account the module is
 * given: the database the external suite reads is one the adapter did not create.
 */
async function ClientDatabase(url: string): Promise<string> {
  await Run(url, [
    `DROP DATABASE IF EXISTS ${CLIENT_DATABASE}`,
    `DROP USER IF EXISTS '${CLIENT_USER}'@'%'`,
    `CREATE DATABASE ${CLIENT_DATABASE}`,
    `CREATE USER '${CLIENT_USER}'@'%' IDENTIFIED BY '${READER_PASSWORD}'`,
    ...Fixture(await EngineOf(url)),
    ...ReaderGrants(CLIENT_USER),
    ...WriterGrants(CLIENT_USER),
  ]);
  return WithDatabase(url, CLIENT_DATABASE, CLIENT_USER);
}

export default defineConfig({
  name: "mysql-test",
  cacheFolder: ".antelope/cache",
  modules:
    MODE === DECORATORS_MODE
      ? {
          local: { source: { type: "local", path: "." } },
          mysql: { source: { type: "local", path: REPOSITORY } },
          api: ApiModuleConfig(ApiPort()),
        }
      : { local: { source: { type: "local", path: "." } } },
  test: {
    folder: MODE === DECORATORS_MODE ? "dist/tests" : "dist/test",
    async setup() {
      adminUrl = await AdminUrl();
      if (MODE !== EXTERNAL_MODE) {
        return moduleConfig({ url: await SuiteDatabase(adminUrl) });
      }
      return moduleConfig({
        url: await ClientDatabase(adminUrl),
        mode: EXTERNAL_MODE,
        catalog: { enabled: true },
      });
    },
    async cleanup() {
      if (adminUrl && suiteDatabase) {
        await Run(adminUrl, [`DROP DATABASE IF EXISTS \`${suiteDatabase}\``]);
      }
      await container?.stop();
    },
  },
});
