<a href="https://github.com/AntelopeJS/antelopejs"><img data-illustration src="./.github/readme/strip.svg" width="100%" alt="PROVIDER · MYSQL: part of AntelopeJS, hexagonal architecture beyond your own code. A glowing button reads Star AntelopeJS."></a>

<div align="center">

# `@antelopejs/mysql`

<a href="https://www.npmjs.com/package/@antelopejs/mysql"><img data-illustration alt="npm" src="https://img.shields.io/npm/v/@antelopejs/mysql?style=for-the-badge&labelColor=000000&color=000000"></a> <a href="./LICENSE"><img data-illustration alt="License" src="https://img.shields.io/npm/l/@antelopejs/mysql?style=for-the-badge&labelColor=000000&color=000000"></a> <a href="https://discord.gg/g4pFt6eXqu"><img data-illustration alt="Discord" src="https://img.shields.io/badge/Discord-18181B?logo=discord&style=for-the-badge&color=000000"></a> <a href="https://interfaces.antelopejs.com/docs/database"><img data-illustration alt="Documentation" src="https://img.shields.io/badge/Docs-18181B?style=for-the-badge&color=000000"></a> <a href="https://github.com/AntelopeJS/antelopejs"><img data-illustration alt="Star AntelopeJS" src="https://img.shields.io/github/stars/AntelopeJS/antelopejs?label=Star%20AntelopeJS&style=for-the-badge&labelColor=000000&color=000000&logo=github"></a>

**The MySQL and MariaDB backend of AntelopeJS. It runs the database interface's queries on MySQL or MariaDB with native column types and indexes, and serves existing tables.**

[Documentation](https://interfaces.antelopejs.com/docs/database) · [Interfaces](#interfaces) · [All interfaces and providers](https://github.com/AntelopeJS/antelopejs#ecosystem)

</div>

The MySQL and MariaDB backend of AntelopeJS. It runs the queries of the database interface on MySQL or MariaDB with the [`mysql2`](https://github.com/sidorares/node-mysql2) driver, and maps schema definitions onto relational tables with native column types and indexes. It can also serve tables that already exist in a database it does not own.

## Interfaces

| Interface                                                                                            | Documentation                                               |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| [`@antelopejs/interface-database`](https://github.com/AntelopeJS/interface-database)                 | [Database](https://interfaces.antelopejs.com/docs/database) |
| [`@antelopejs/interface-database-catalog`](https://github.com/AntelopeJS/interface-database-catalog) | [The catalog](./docs/external-mode.md#the-catalog)          |

The database interface pages document schemas, tables, queries, change feeds and atomic mutations. The catalog answers on an external instance only.

## Requirements

<!-- antelopejs-docs-node:start -->

This package requires Node.js `>=22`.
<!-- antelopejs-docs-node:end -->

The module supports MySQL 8.4 LTS, MySQL 9.7 LTS, MariaDB 11.8 LTS and MariaDB 12.3 LTS, and `pnpm test` runs every suite on all four. It reads the server's version when it connects and picks the MySQL or the MariaDB dialect. [MariaDB](./docs/mariadb.md) lists every behaviour that differs between the two.

A date part read in a named time zone, such as `hours("Europe/Paris")`, needs the server's time zone tables (`mysql.time_zone_name` and the tables beside it). The official `mysql` and `mariadb` images load them unless `MYSQL_INITDB_SKIP_TZINFO` or `MARIADB_INITDB_SKIP_TZINFO` is set. On a server without them, every named zone, `UTC` included, reads as `null` with no error. Load them with `mysql_tzinfo_to_sql /usr/share/zoneinfo | mysql -u root mysql` or `mariadb-tzinfo-to-sql /usr/share/zoneinfo | mariadb -u root mysql`. An offset such as `"+02:00"` needs no tables. See [Behaviour worth knowing](./docs/behaviour.md#reading-a-value).

## Install

```bash
ajs project modules add @antelopejs/mysql
```

The command writes the module's default configuration, the URL `mysql://root@localhost:3306/antelopejs` with `migrations: "safe"`.

The account in the URL needs `CREATE`, `ALTER`, `INDEX`, `TRIGGER`, `LOCK TABLES`, `SELECT`, `INSERT`, `UPDATE` and `DELETE` on that one database. The module creates no database of its own.

The first `changes()` on a table creates triggers on it. With binary logging on, which is MySQL's default, the server refuses `CREATE TRIGGER` (errno 1419) unless the account holds `SUPER` or the server runs with `log_bin_trust_function_creators = 1`. Before you open a change feed, either `GRANT SUPER ON *.* TO` the account, or run `SET GLOBAL log_bin_trust_function_creators = 1` and put it in the server's configuration file. `SYSTEM_VARIABLES_ADMIN` and `SET_ANY_DEFINER` do not replace `SUPER` for a trigger, on 8.4 or 9.7. Without either, the feed fails with an error that names both remedies. See [Change feeds](./docs/change-feeds.md#what-the-account-needs).

## Configuration

```typescript [antelope.config.ts]
import { defineConfig } from "@antelopejs/interface-core/config";

export default defineConfig({
  name: "my-project",
  modules: {
    mysql: {
      source: {
        type: "package",
        package: "@antelopejs/mysql",
        version: "latest",
      },
      config: {
        url: "mysql://app@localhost:3306/my_project",
        migrations: "safe",
        pool: { connectionLimit: 10 },
      },
    },
  },
  envOverrides: {
    MYSQL_URL: "modules.mysql.config.url",
  },
});
```

| Key            | Description                                                                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`         | `"owned"` (default) creates and converges the tables. `"external"` serves existing tables without changing them.                                                                                                        |
| `url`          | MySQL connection string. Its database holds every table the module owns.                                                                                                                                                |
| `migrations`   | `"safe"` (default) adds columns and indexes, and also drops or swaps the indexes that the adapter owns. `"destructive"` also retypes and drops columns. See [Schema convergence](./docs/storage.md#schema-convergence). |
| `schemaPrefix` | Prefix for generated table names, for several applications sharing one database.                                                                                                                                        |
| `pool`         | Optional [`mysql2` pool](https://sidorares.github.io/node-mysql2/docs#using-connection-pools) options, merged under the URL. The module refuses the options it sets itself.                                             |

[docs/configuration.md](./docs/configuration.md) lists the options for cursors, the statement timeout and change feeds.

## Quick start

In the module that stores data, add the database interface:

```bash
pnpm add @antelopejs/interface-database
```

Then follow the [database interface guide](https://framework.antelopejs.com/docs/guides/database) to declare a schema and query it. The same code runs on [`@antelopejs/postgres`](https://github.com/AntelopeJS/postgres), [`@antelopejs/mongodb`](https://github.com/AntelopeJS/mongodb) and [`@antelopejs/rethinkdb`](https://github.com/AntelopeJS/rethinkdb). [Behaviour worth knowing](./docs/behaviour.md) records where the backends differ.

## Storage layout

Unlike the document-store backends, this module turns schema field declarations into DDL. Every table of every schema lives in the database the URL names, as a real table, and each declared scalar field is a column with a native type. A query compiles to a single SQL statement. Filters become `WHERE` clauses, joins become `JOIN`s, and a `filter` or `orderBy` over an indexed field reaches its index.

- One table per schema table, named `<schemaPrefix><schemaId>__<tableId>`. No MySQL database per schema id.
- Declared scalar fields become typed columns. Objects, arrays and undeclared fields live in `JSON`.
- Every text column compares in `utf8mb4_0900_bin`, or `utf8mb4_nopad_bin` on MariaDB: by code point, case-sensitive, trailing spaces significant.
- An index on text or on a path inside JSON keys on a generated `VIRTUAL` column, and a dotted index field such as `title.fr` reads a nested JSON path.
- An `_instance` discriminator column keeps schema instances apart.
- Schema convergence runs one statement per step, so a crash leaves nothing half done, and builds secondary indexes online.
- Change feeds are row triggers, one log and a pull-based reader.

## Documentation

- [Database](https://interfaces.antelopejs.com/docs/database) is the `@antelopejs/interface-database` contract that this module implements.
- [Configuration](https://framework.antelopejs.com/docs/concepts/configuration) covers module sources, `config` blocks and config variables in `antelope.config.ts`.

This repository documents what is specific to the MySQL backend:

|                                                |                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [Storage and schema](./docs/storage.md)        | What a registered schema becomes in the database, the field-type table, what reaches an index, and how registration converges         |
| [Configuration](./docs/configuration.md)       | Every option `construct` accepts                                                                                                      |
| [External mode](./docs/external-mode.md)       | Reading tables the module did not create, in a database it does not own                                                               |
| [Change feeds](./docs/change-feeds.md)         | `changes()`, its ordering guarantee, its retention contract and its blind spots                                                       |
| [Errors and refusals](./docs/errors.md)        | Everything the module refuses, with the message it refuses by                                                                         |
| [Behaviour worth knowing](./docs/behaviour.md) | Things that answer rather than throw, where the answer may surprise you, including where this backend differs from the PostgreSQL one |

## Compatibility

<!-- antelopejs-docs-compat:start -->

| Package                                  | Supported        | Tested with |
| ---------------------------------------- | ---------------- | ----------- |
| `@antelopejs/interface-core`             | `>=0.5.1 <0.6.0` | `0.5.1`     |
| `@antelopejs/interface-database`         | `>=0.4.0 <0.5.0` | `0.4.0`     |
| `@antelopejs/interface-database-catalog` | `>=0.0.4 <0.1.0` | `0.0.4`     |

<!-- antelopejs-docs-compat:end -->

CI tests every Node.js major listed under `node-versions` in [`.github/workflows/ci.yml`](.github/workflows/ci.yml), and [`.nvmrc`](.nvmrc) names the version for local work. The `dependencies` field of [`package.json`](package.json) sets the `mysql2` driver range, and [`scripts/test.sh`](scripts/test.sh) names the MySQL images that the tests run against.

## Contributing

The `engines` field of [`package.json`](package.json) sets the Node.js floor. The floor comes from Testcontainers, a dev dependency whose own `engines` field and whose bundled `undici` set the same major.

```bash
pnpm install
pnpm lint
pnpm format:check
pnpm knip
pnpm test:unit      # fast loop: this repository's unit specs, no Docker
pnpm test           # everything, on MySQL 8.4 and 9.7 and MariaDB 11.8 and 12.3: owned, external and decorators suites
```

`pnpm test` starts one server container per image with Docker, so it needs a Docker daemon. Set `MYSQL_TEST_IMAGES` to a space-separated list of images to test others. It tests two images at a time, since the change-feed tests measure how long a server takes; set `MYSQL_TEST_PARALLEL` to change that. Besides this repository's own tests, it runs the shared conformance suites of the interfaces listed in `antelopeJs.implements`, and the `@antelopejs/interface-database-decorators` suite through [`scripts/decorators.sh`](scripts/decorators.sh).

To test against an existing server instead of a container, set `MYSQL_TEST_URL`. It must point to a disposable server, because the suites create and drop databases and the external suite creates and drops an account.

```bash
MYSQL_TEST_URL=mysql://root:secret@localhost:3306/mysql pnpm test
```

Read the [contribution guidelines](CONTRIBUTING.md) before opening a pull request.

## Part of AntelopeJS

This package belongs to [AntelopeJS](https://github.com/AntelopeJS/antelopejs), the TypeScript framework where modules depend on contracts and the application chooses the provider. The open-source back office [AntelopeJS DMS](https://github.com/AntelopeJS/dms) is built on it.

<!-- antelopejs-framework-modules:start -->

| Area         | Contracts                                                                                                                                                                                                                                                                                                                                                                                                                  | Providers                                                                                                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API          | [`interface-api`](https://github.com/AntelopeJS/interface-api) · [`interface-api-util`](https://github.com/AntelopeJS/interface-api-util) · [`interface-data-api`](https://github.com/AntelopeJS/interface-data-api)                                                                                                                                                                                                       | [`api`](https://github.com/AntelopeJS/api)                                                                                                                                                                                                          |
| Auth         | [`interface-auth`](https://github.com/AntelopeJS/interface-auth)                                                                                                                                                                                                                                                                                                                                                           | [`auth-jwt`](https://github.com/AntelopeJS/auth-jwt)                                                                                                                                                                                                |
| Database     | [`interface-database`](https://github.com/AntelopeJS/interface-database) · [`interface-database-decorators`](https://github.com/AntelopeJS/interface-database-decorators) · [`interface-database-catalog`](https://github.com/AntelopeJS/interface-database-catalog) · [`interface-mongodb`](https://github.com/AntelopeJS/interface-mongodb) · [`interface-rethinkdb`](https://github.com/AntelopeJS/interface-rethinkdb) | [`postgres`](https://github.com/AntelopeJS/postgres) · **`mysql`** · [`mongodb`](https://github.com/AntelopeJS/mongodb) · [`rethinkdb`](https://github.com/AntelopeJS/rethinkdb)                                                                    |
| Redis        | [`interface-redis`](https://github.com/AntelopeJS/interface-redis) · [`interface-redis-scheduler`](https://github.com/AntelopeJS/interface-redis-scheduler)                                                                                                                                                                                                                                                                | [`redis`](https://github.com/AntelopeJS/redis)                                                                                                                                                                                                      |
| Email        | [`interface-email`](https://github.com/AntelopeJS/interface-email)                                                                                                                                                                                                                                                                                                                                                         | [`nodemailer`](https://github.com/AntelopeJS/nodemailer) · [`brevo`](https://github.com/AntelopeJS/brevo)                                                                                                                                           |
| File storage | [`interface-file-storage`](https://github.com/AntelopeJS/interface-file-storage)                                                                                                                                                                                                                                                                                                                                           | [`file-storage-local`](https://github.com/AntelopeJS/file-storage-local) · [`file-storage-s3`](https://github.com/AntelopeJS/file-storage-s3)                                                                                                       |
| Payments     | [`interface-payment`](https://github.com/AntelopeJS/interface-payment) · [`interface-subscriptions`](https://github.com/AntelopeJS/interface-subscriptions) · [`interface-stripe`](https://github.com/AntelopeJS/interface-stripe)                                                                                                                                                                                         | [`stripe`](https://github.com/AntelopeJS/stripe) · [`mollie`](https://github.com/AntelopeJS/mollie) · [`checkout-com`](https://github.com/AntelopeJS/checkout-com) · [`payment-subscriptions`](https://github.com/AntelopeJS/payment-subscriptions) |

<!-- antelopejs-framework-modules:end -->

## License

[Apache-2.0](LICENSE)
