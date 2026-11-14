---
title: Configuration
description: Every option that construct accepts in the MySQL module, with its default and what it does.
mode: reference
---

Every option that `construct` accepts, and what each one does.

```typescript fragment
{
    mode: "owned",                      // "owned" (default) or "external"
    url: "mysql://root@localhost:3306/antelopejs",  // MySQL connection string
    migrations: "safe",                 // "safe" (default) or "destructive"
    schemaPrefix: "",                   // Prefix for generated table names
    dialect: "auto",                    // "auto" (default), "mysql" or "mariadb"
    cursorBatchSize: 100,               // Rows read per batch when iterating
    cursorIdleTimeoutMs: 60000,         // Idle cursors are reclaimed after this delay
    maxOpenCursors: 5,                  // Half of pool.connectionLimit, at least 1
    statementTimeoutMs: undefined,      // Optional timeout for SELECT statements
    changeRetentionMs: 300000,          // How long a change event stays readable, a contract
    changeBatchSize: 256,               // Change events read per round trip
    changePollIntervalMs: 100,          // How often the log is read while a feed is open
    pool: {},                           // Optional mysql2 pool options, merged under the URL
    catalog: {}                         // External mode only: { enabled?: boolean }
}
```

Every value above is the module's own default. Two are derived. `maxOpenCursors` is half of `pool.connectionLimit`, rounded down and at least 1, so it is 5 with the driver's default pool. `pool` defaults to `{}`, and every option you leave out of it keeps the default of `mysql2`, not one of this module's. Those defaults are `connectionLimit: 10`, `waitForConnections: true`, `queueLimit: 0`, `connectTimeout: 10000` and `idleTimeout: 60000`. With `waitForConnections: true` and `queueLimit: 0`, a statement waits for a free connection without a deadline.

## Details

The module uses the `mysql2` driver and leaves pooling to its pool:

- The account in `url` needs the privileges that [the README](../README.md#install) lists. A change feed needs `SUPER` or a server with `log_bin_trust_function_creators = 1` besides, as [Change feeds](./change-feeds.md#what-the-account-needs) explains.
- The module passes `url` as `uri` and merges everything in `pool` under it. The URL wins over a connection setting given in both.
- `pool` refuses the options the module sets itself, because the module's decoding and statements depend on them: `charset`, `timezone`, `jsonStrings`, `dateStrings`, `supportBigNumbers`, `bigNumberStrings`, `decimalNumbers`, `typeCast`, `namedPlaceholders`, `rowsAsArray`, `nestTables`, `multipleStatements`, `flags`, `maxPreparedStatements`, `resetOnRelease`, `uri`, `charsetNumber` and `queryFormat`. Connection limits, timeouts, TLS and `connectAttributes` are yours to set.
- `construct` opens the pool and checks one connection, so a bad configuration fails at startup, not on the first query. An external instance where the catalog answers is the exception. See [A connection that fails at startup](./external-mode.md#a-connection-that-fails-at-startup).
- `dialect: "auto"` reads `SELECT VERSION()` on that first connection and picks `"mariadb"` for a version that names MariaDB, `"mysql"` for any other. `dialect: "mysql"` and `dialect: "mariadb"` skip the read. See [MariaDB](./mariadb.md).
- Every connection runs one session pin before its first statement, and a connection whose pin fails is destroyed, never handed out. The pin is `SET NAMES utf8mb4 COLLATE utf8mb4_0900_bin` (`utf8mb4_nopad_bin` on MariaDB, which also sets `group_concat_max_len` to its largest value, `max_sort_length` to 16,384 bytes and `sort_buffer_size` to at least 2 MiB), `time_zone = '+00:00'`, `sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION'` and `lc_messages = 'en_US'`. Literals and bound values then compare as the columns do, a date reads the same way whatever the server's time zone is, a value a column cannot hold fails its statement, and the server's messages that the module parses stay in English.
- A cursor streams its rows on a connection it holds for as long as it is open. `maxOpenCursors` caps the open cursors, so iterations cannot take every pooled connection, and a cursor past the cap is refused with a message naming the setting. A statement that waits more than 10 s for a pooled connection logs a warning that names both causes: every connection checked out, or a server that does not answer.
- `statementTimeoutMs` becomes the session's `max_execution_time`, which MySQL applies to `SELECT` statements only. On MariaDB it becomes `max_statement_time`, which applies to every statement, so the module lifts it for each write and DDL statement with `SET STATEMENT max_statement_time = 0 FOR`. Writes and DDL run without it on both. Unset or `0` leaves reads unbounded. A cursor reads on a connection where the timeout is lifted, because the server counts a streaming `SELECT` as running until its last row is read, and restores it when it gives the connection back.
- `mode: "external"` serves tables that already exist in a database the module does not own. See [External mode](./external-mode.md). It refuses `schemaPrefix`, `migrations` and the three `change*` options by name, because none of them applies there. It also refuses an empty or missing `url`. An owned instance without a `url` connects to the default.
- `migrations` controls how far registration may go. See [Schema convergence](./storage.md#schema-convergence).
- `schemaPrefix` is for several applications that share one database. It is the start of every table name the module derives, and part of the key that the instance registry and the convergence locks use.
- `cursorBatchSize`, `cursorIdleTimeoutMs`, `maxOpenCursors` and the three `change*` options are refused unless they are positive safe integers. `statementTimeoutMs` is refused unless it is a non-negative safe integer. Several of them reach statement text as literals, which is why `construct()` validates them.
- `changeRetentionMs` is a contract, not a tuning value. It sets how long a consumer may stall before its feed is ended. See [Change feeds](./change-feeds.md).
- `changePollIntervalMs` bounds how late a feed sees a write committed by another process. A write committed by this process wakes the feeds at once.
- `catalog.enabled` turns the catalog of an external instance on or off. Unset, the catalog follows the project's development mode. See [The catalog](./external-mode.md#the-catalog).
