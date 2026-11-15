---
title: The connection probe
description: Reference for the probe that signs in to a MySQL or MariaDB URL and reports what its account may do, outside the AntelopeJS runtime.
mode: reference
---

`@antelopejs/mysql/dist/probe` exports `probe`, typed `Probe` by `@antelopejs/interface-database-catalog`. It loads outside the AntelopeJS runtime, so a tool can check a URL before any instance is configured with it:

```typescript fragment
const { probe } = require("@antelopejs/mysql/dist/probe");
const answer = await probe({
  url: "mysql://dms_client:…@db:3306/sales",
  timeoutMs: 5000,
  signal,
});
```

The probe signs in on a connection of its own, runs no statement that writes, and never rejects. The driver runs in a worker thread of the probe's own, so nothing a server sends can end the calling process. It answers one of three outcomes:

- `signed-in`, with `CURRENT_USER()` as `user` and the time the first query took as `latencyMs`, rounded up. `canRead` and `canWrite` come from the relations of the URL's database, each decided as the catalog decides it. The account reads when it may `SELECT` from any relation as a whole, or sees none. It writes when it may `CREATE` a table in the database, so an empty database it may build in is not read-only, or when it may `INSERT`, `UPDATE` or `DELETE` in any relation. The probe asks the server to prepare a `CREATE TABLE` and never runs it. `INSERT` and `UPDATE` count only on a relation it may read. A URL with no database answers `unreadable: "no-database-named"`. A server error that refuses or fails the listing after the sign-in, or that says the server could not take up a relation's check, answers `canRead: false`, `canWrite: false` and `unreadable: "cannot-list"`, with the account's `user` and `latencyMs`.
- `refused`, when the server turns the sign-in down. `ER_ACCESS_DENIED_ERROR` is `credentials`, or `sign-in-required` when the URL gives no password. `ER_HOST_NOT_PRIVILEGED` is `host`, `ER_BAD_DB_ERROR` is `database` and `ER_DBACCESS_DENIED_ERROR` is `database-denied`. Any other `ER_*` is `other`, and so is a server that greets the probe and then asks for what it does not give: the password in clear, an authentication plugin `mysql2` lacks, TLS it does not offer, or a certificate that fails. A URL option the probe does not take answers `other` before the probe connects.
- `unreachable`, when no server answered. That covers a wrong host or port, a socket path nothing listens on, a connection cut after the sign-in, and a step that took longer than `timeoutMs`.

The probe signs in with the user name and password of the URL and nothing else. `mysql2` reads no environment variable such as `MYSQL_PWD` and no option file such as `~/.my.cnf`. The probe never sends a password in clear: a server that switches to `mysql_clear_password` is refused, whatever the URL's `enableCleartextPlugin`. It reads no local file a server asks for with `LOAD DATA LOCAL INFILE`. Of the URL's query options, the probe keeps only what changes how the connection is made:

- `socketPath`, as text.
- `localAddress`, as an IP address.
- `ssl`, so a URL that asks for TLS gets it. That is either the name of one of `mysql2`'s TLS profiles, or an object of `ca` (PEM text, which `mysql2` passes to TLS and never opens as a path), `rejectUnauthorized`, `verifyIdentity`, `minVersion`, `maxVersion` and `ciphers` only.

It refuses an `ssl` of any other kind. That includes one that presents a client certificate (`cert`, `key`, `pfx` or `passphrase`), a credential beside the URL's user and password. It also includes a profile named after a property every object has, such as `__proto__`, on which `mysql2` would write over `Object.prototype`.

It takes out of the URL every option it sets itself, such as `rowsAsArray` or `connectTimeout`. It also takes out every option that only tunes the driver, the transport or a pool, such as `compress`, `connectAttributes` or `connectionLimit`. It refuses `infileStreamFactory`, `authPlugins`, `authSwitchHandler`, `isServer`, `queryFormat`, `insecureAuth`, `debug`, `Promise`, the extra passwords `password1` to `password3` and `passwordSha1`, and any option `mysql2` does not take.

`timeoutMs` bounds the connect and each statement. A `socketPath` in the URL's query is connected to in place of its host and port. Over a local socket, the server may sign the probe in as the OS user the project runs as, whatever user and password the URL gives, so `user` is always the account the server reports, never the URL's. A socket path that nothing answers at answers the same message whatever is at the path. Once the probe has answered, it says goodbye and shuts its socket, even when the server ignores the goodbye. When `signal` aborts before the probe has answered, the probe shuts its socket at once and answers `{ outcome: "unreachable", message: "The probe was aborted." }`. It opens nothing for a signal that has already aborted.
