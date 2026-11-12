---
title: External mode
description: Reference for serving the existing tables of a database that the MySQL module does not own, from registration and values to writes, refusals and the catalog.
mode: reference
---

`mode: "external"` points the module at tables that already exist, in a database it does not own, and reads and writes their rows. It describes an existing database to AntelopeJS, usually through a schema written from the client's catalog. It never changes the structure of that database.

```typescript fragment
{
    mode: "external",
    url: "mysql://dms_reader@client-db:3306/erp",
}
```

`url` is required. An external instance without one, or with an empty one, refuses to construct. It does not fall back to the default of the owned mode. Projects usually set it through `envOverrides`, so the credentials stay out of the repository:

```typescript fragment
envOverrides: { ERP_DATABASE_URL: "modules.mysql-erp.config.url" },
```

A project that needs both kinds of table runs two instances of this module, one owned and one external. It pins each consumer to one instance through `importOverrides`.

## The schema mirrors the database

Nothing is mapped. The declaration uses the database's own names, verbatim:

- The schema id is the MySQL database: `RegisterSchema("sales")`. This is the one place where a schema id names a database. An owned instance keeps every table in the URL's database.
- The table id is the table or view: `@RegisterTable("accounts", "sales")`.
- A field is a column: `@Field("string") declare first_name: string`.

The module quotes names with backticks as they are, and never prefixes or shortens them. Messages name a relation the same way, as in `` `sales`.`accounts` ``.

## What registration does

Registration reads `information_schema` once per declared table, and does nothing else. It runs no DDL, creates no bookkeeping table, installs no trigger, and keeps no change log. A failure here fails the schema's registration, so every query on the schema fails with the same message from startup. These declarations fail:

- A declared table that does not exist, or that the account cannot see.
- A table the account may read only some columns of.
- A declared field whose column does not exist.
- A declared type that the column cannot be read as, such as `number` over a `VARCHAR`, and a column of a type no field type reads, such as `BLOB` or `GEOMETRY`.

Registration reads privileges from `information_schema`, granted globally, on the database or on the table. A privilege granted only through a role is not seen.

Registration accepts some pairings with a warning, because reading them loses something:

| Declared | Column                     | Warning                                                                     |
| -------- | -------------------------- | --------------------------------------------------------------------------- |
| `number` | `BIGINT`                   | a value beyond 2^53 loses precision; declare it `string` to read it exactly |
| `number` | `DECIMAL`                  | it loses precision; declare it `string` to read it exactly                  |
| `number` | `FLOAT`                    | the widened value is not the decimal it was written as                      |
| `date`   | `DATETIME`                 | it holds no time zone and is read as UTC                                    |
| `date`   | a precision above 3 digits | microseconds are truncated to milliseconds                                  |

Registration also accepts, with a warning, a declared index that no index of the database leads with. The query stays correct, and may be slow.

## Values

The module reads each column as the type that its field declares, the same way whatever the time zone of the server or of the Node.js process:

| Declared                | Columns it reads                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `string`                | `CHAR`, `VARCHAR`, the `TEXT` types, `ENUM`, `SET`, `TIME`, `YEAR`, the integer types and `DECIMAL` |
| `number`                | the integer types, `TINYINT(1)`, `DECIMAL`, `FLOAT` and `DOUBLE`                                    |
| `boolean`               | `TINYINT(1)`                                                                                        |
| `date`                  | `TIMESTAMP`, `DATETIME` and `DATE`                                                                  |
| `object`, `any`, a list | `JSON`                                                                                              |

- `DATETIME` reads as UTC, and `DATE` as midnight UTC.
- A `BIGINT` or `DECIMAL` declared `string` reads as its exact text.
- Comparisons, `get`, `getAll`, `lookup` and `orderBy` compare the column in its own type, so the database's indexes serve them. A value that is not valid for the column, such as an unknown `ENUM` label, a fraction for an integer, or text its character set cannot hold, such as an emoji against a `utf8mb3` or `latin1` column, matches nothing. It does not fail the query.
- Sorting follows the column's own order. An `ENUM` sorts in its declared order but compares by its label, and a `BIGINT` declared `string` sorts numerically.
- A text column compares in its own collation, as the column does, and so does each text part of a composite `_id`. One ending in `_ci` ignores case.
- MySQL has no `uuid` type. A `CHAR(36)` key accepts any 36 characters.

## `_id`

Every row of a table with a key answers `_id`, the key as a string, beside the key columns under their own names. Declare it as `@Field("string") declare _id: string`.

- With a single-column primary key, `_id` is its value: `"42"`. A date or a time key reads as the server spells it in UTC, such as `"2026-01-01 10:00:00.123456"`.
- With a composite primary key, `_id` is its parts as a JSON array of strings: `["42", "3"]`. It is read as JSON, so every escape JSON defines is understood in it, such as `\n` for a part that holds a newline. An `_id` that is not such an array names no row.
- With no primary key but a unique index over `NOT NULL` columns, that index is the key. If several qualify, the one with the fewest columns wins, then the first by name. A prefix index and an invisible index never count. A `FLOAT`, `DOUBLE`, `SET` or `JSON` column is never part of a key.

The module reads a relation with no key at all without `_id`: a table without a primary key or such an index, and every view. Queries, counts and aggregations work. `get`, `getAll` without an index, and `_id` itself are refused, and declaring `_id` on such a relation fails registration.

## Writing

`insert`, `update`, `replace` and `delete` work on every relation that has a key, as described above. A relation without a key is read-only.

- A payload names declared fields only. The module refuses any other key by name, `_internal` included.
- `_id` and the key columns say which row is written, and the module never assigns them. An `update` whose `_id` names another row writes nothing and answers 0. On `insert`, they are the new row's key.
- An `AUTO_INCREMENT` key may be left out of an `insert`, and the module answers the key the database generated. It also accepts an explicit value, as MySQL does. A key that only a `DEFAULT` expression such as `UUID()` fills must be given, because nothing answers it back.
- The database fills generated columns, and the module treats `SET` columns as read-only. `update` and `replace` ignore a value for one of them, so writing back a whole row that you read works. `insert` refuses such a value.
- A field that an `insert` leaves out takes the column's `DEFAULT`. A field that `replace` leaves out takes its `DEFAULT` too, or NULL when it has none. `update` clears a field given as `undefined` or `null`.
- The module checks every value it can against its column's exact type before it writes anything, because MySQL rounds silently where it could refuse: a string too long for `VARCHAR(n)`, an unknown `ENUM` label, a fraction or an out-of-range number for an integer, too many integer digits for a `DECIMAL`, and a date out of range for its column. A value that does not fit refuses the write and names the field. Strict mode refuses the rest, and that error is mapped the same way.
- A column keeps its stored value when the written value equals what a read of it answers. A row that you read and write back whole therefore loses nothing that a read could not spell, such as a `BIGINT` beyond 2^53 read as a number, or microseconds. A write that changes nothing changes no row and answers 0.
- `insert` answers each new row's `_id` in input order, keys that the database generates included. Each document is one `INSERT`, all in one transaction.
- `insert` with a conflict mode locks the row by its key, then updates or inserts it. A clash on another unique index still fails, as `duplicate`.
- A constraint that the database enforces surfaces as an `ExternalWriteError`. Its `kind` is `invalid`, `missing`, `duplicate`, `reference`, `referenced`, `check` or `forbidden`, and it names the field or the constraint concerned. [Errors and refusals](./errors.md#external-write-errors) lists the errno behind each kind.

Triggers, cascades and other writers on the client's side belong to the client. Nothing reports what they change.

## What is refused

Each of these fails with a message that names what was refused:

- Writes to a relation without a key, and `atomicMutation`.
- `update` with an expression mapper, such as `update(row => …)`.
- `changes()`.
- A named instance, `createInstance` and `destroyInstance`. `listInstances` answers an empty list. External tables have no instances, so the default instance and `CROSS_INSTANCE` both read every row.

A read does not refuse a field that the declaration does not name. The field is absent, as on any document that lacks it.

## The account to connect with

Give the module an account that can read, can write the rows it should, and can do nothing else:

```sql
CREATE USER 'dms_client'@'%' IDENTIFIED BY '…';
GRANT SELECT ON sales.* TO 'dms_client'@'%';
GRANT INSERT, UPDATE, DELETE ON sales.orders TO 'dms_client'@'%';
GRANT INSERT, UPDATE, DELETE ON sales.customers TO 'dms_client'@'%';
```

A write to a table that the account was not granted fails as `forbidden`. The module never needs more. With this account, a module wired by mistake to an owned instance on this URL fails at its first `CREATE` and does not change the client's database. Set `statementTimeoutMs` too, because these are someone else's production tables. It bounds `SELECT` statements only, as MySQL's `max_execution_time` does.

## The catalog

An external instance also implements `@antelopejs/interface-database-catalog`. The catalog describes and profiles the database for a generator: relations, columns, keys, references, row estimates, and aggregates over the data. It answers with this module's own registration rules. A relation that it calls mappable registers, and the declarations that it lists for a column are the ones that registration accepts.

- `Info` answers the engine `mysql`, the URL's database and the user part of `CURRENT_USER()` as the role.
- A relation's kind is `table`, `partitioned` or `view`. MySQL has no materialized views and no foreign tables.
- A table's row estimate is `information_schema.TABLES.TABLE_ROWS`, an InnoDB estimate that the server caches. A view's estimate comes from its plan, which needs the `SHOW VIEW` privilege.
- An `AUTO_INCREMENT` column is reported as an identity generated `by default`.
- A relation with column-only grants is listed as unmappable, with the reason.

The catalog is a development tool. It answers under `ajs project dev` and `ajs project run`. It refuses under `ajs project start` unless you turn it on:

```typescript fragment
{
    mode: "external",
    url: "…",
    catalog: { enabled: true },
}
```

An owned instance refuses it.

### A connection that fails at startup

Wherever the catalog answers, an external instance whose first connection fails still starts. The catalog answers in development unless `catalog.enabled` says otherwise. The instance keeps the failure as the reason it has no connection, and every catalog and database call refuses with `MySQL adapter is not connected: <reason>`. A builder can then show the reason and let someone fix the URL, and a typo does not stop the whole project.

The module words the common reasons as a sentence and keeps the driver's code:

| Code                                     | Reason                                                  |
| ---------------------------------------- | ------------------------------------------------------- |
| `ER_ACCESS_DENIED_ERROR`                 | wrong user or password                                  |
| `ER_BAD_DB_ERROR`                        | the database does not exist                             |
| `ER_DBACCESS_DENIED_ERROR`               | the user may not use the database, or it does not exist |
| `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT` | the server is not answering at `host:port`              |
| `ER_SECURE_TRANSPORT_REQUIRED`           | the server requires SSL                                 |

MySQL answers `ER_DBACCESS_DENIED_ERROR` to an account that asks for a database it may not see, whether or not the database exists. Any other failure keeps the driver's message. Nothing retries in place. The instance connects again when the project reloads and constructs it again, for example after its URL changes in `.env`.

Nothing else changes. Without `url`, an external instance still refuses to construct. Where the catalog does not answer, as under `ajs project start`, a failed connection fails construct. An owned instance always fails construct when it cannot connect.

Each consumer reaches the catalog through a connection on its own module entry. Two consumers of the same database give their connections the same id:

```typescript fragment
"dms-builder": {
    importOverrides: [
        { interface: "@antelopejs/interface-database-catalog", source: "mysql-erp", id: "erp" },
    ],
},
"dms-ai": {
    importOverrides: [
        { interface: "@antelopejs/interface-database-catalog", source: "mysql-erp", id: "erp" },
    ],
},
```

**Profiles never write and never wait long.**

- Every profile runs in one `START TRANSACTION READ ONLY` on a connection of its own, whatever the connected account may write, and that connection is closed afterwards. Each measure has a 5 s `max_execution_time` and a 1 s lock wait.
- A measure that times out answers `{ status: "timeout" }`, and the rest of the profile stands.
- MySQL has no block sampling. A table estimated above one million rows keeps the rows whose key's `CRC32` falls in one bucket of as many as it takes to read about 100,000, the same rows every time. A table without a key keeps a seeded random share. Either way the server still scans the table, within the measure's timeout. A view above that size is read up to its first 100,000 rows.
- Calls run one at a time.

**Profiles answer aggregates, not rows.**

- Text columns answer no minimum or maximum.
- A profile names a value only as a category of a column with at most 25 distinct values, and only if the value is counted at least 5 times.

**A sample of rows is for a person.** `SampleRows` is the one catalog function that answers row values. They are for a person to look at, never for a generator or a model.

- It answers at most 20 rows, every value as text cut at 200 characters, and a binary value as its length.
- It reads in the same `READ ONLY` transaction and with the same timeouts as a profile, and samples a relation above one million rows the same way.
