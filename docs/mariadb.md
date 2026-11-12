---
title: MariaDB
description: Reference for running the MySQL module on MariaDB 11.8 LTS and 12.3 LTS, and every place it behaves differently from MySQL.
mode: reference
---

The module runs on MariaDB 11.8 LTS and MariaDB 12.3 LTS as well as on MySQL 8.4 and 9.7. `pnpm test` runs the owned, external and decorators suites on all four servers, and CI does the same. This page lists every behaviour that differs between the two engines. Anything it does not name behaves as the rest of the documentation describes.

## Detection

`dialect: "auto"`, the default, reads `SELECT VERSION()` on the first connection. A version that contains `MariaDB` selects the MariaDB dialect, and any other version selects MySQL. `dialect: "mariadb"` and `dialect: "mysql"` skip the read. See [Configuration](./configuration.md).

The two dialects share one implementation in `src/dialect/mysql/`. `src/dialect/mariadb/` holds only what MariaDB spells differently, as one table of differences, so no compiler, planner or runtime file names an engine.

## Session and storage

| MySQL                                                           | MariaDB                                                                                            | Why                                                                                                                                                                                             |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every column, literal and bound value is `utf8mb4_0900_bin`     | They are `utf8mb4_nopad_bin`                                                                       | Both are binary and pad nothing, so text compares by code point and trailing spaces count on both. The server's default collation, `utf8mb4_uca1400_ai_ci` on MariaDB, never applies            |
| A document column is `JSON`                                     | It is `JSON COLLATE utf8mb4_nopad_bin`, which MariaDB stores as `LONGTEXT` checked by `JSON_VALID` | The catalog reports such a column as `longtext`. The module reads its check to recognise it, so convergence does not see a changed type                                                         |
| MySQL sorts a stored document's keys and normalises its numbers | MariaDB stores the text as written                                                                 | A document reads back with its keys in the order they were written, and `1.0` stays `1.0`. Deep equality in JavaScript is unaffected                                                            |
| `statementTimeoutMs` sets `max_execution_time` in milliseconds  | It sets `max_statement_time` in seconds, to the millisecond                                        | A read that runs out of time fails with errno 1969 instead of 3024                                                                                                                              |
| A document nests at most 100 levels                             | MariaDB 11.8 refuses a document of 32 nested containers. 12.3 has no such limit                    | A write of a deeper document fails on 11.8 with `CONSTRAINT `table.column` failed` (errno 4025). A change feed logs a value deeper than 29 levels as its JSON text, as it does past 98 on MySQL |
| `GROUP_CONCAT` has no bearing on JSON aggregates                | The pin sets `group_concat_max_len` to its largest value                                           | MariaDB builds `JSON_ARRAYAGG` and `JSON_OBJECTAGG` on group concatenation, which would otherwise cut an aggregate at 1 MB                                                                      |

MySQL 8.4 reads some doubles of 17 significant digits back from JSON text as a neighbouring double, so the module binds such numbers as `DOUBLE` there. MariaDB keeps the text it is given, so the module sends every JSON constant as text, a negative zero spelled `-0`.

## Indexes

| MySQL                                                                          | MariaDB                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `multi` index over an array builds a multi-valued index                      | MariaDB has none. Registration leaves the index out with a warning that names it, and `includes` and `getAll` over the array test every row                                                                             |
| A nested path such as `title.fr` reaches an index through a VIRTUAL key column | The same key columns, which MariaDB indexes as it does any virtual column. MariaDB never matches an expression to a generated column on its own, and the module names the key column in every read that an index serves |
| A join no index serves is a hash join                                          | It is a block nested loop join through a join buffer, which also reads the joined table once for many rows                                                                                                              |

## Queries

The module compiles the same queries to SQL that MariaDB accepts. Where MariaDB lacks a construct, the module writes an equivalent:

| Construct MySQL has                              | What the module writes on MariaDB                                                                                                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAST(text AS JSON)`                             | `JSON_EXTRACT(text, '$')`, whose result every JSON function takes as JSON                                                                                                                                               |
| `->` and `->>`                                   | Neither engine's SQL uses them. Both read a path with one `JSON_EXTRACT`                                                                                                                                                |
| `value MEMBER OF (array)`                        | An `EXISTS` over `JSON_TABLE(array)` that compares each element with `JSON_EQUALS`. `JSON_CONTAINS` would also match the value inside a nested array                                                                    |
| `LEFT JOIN LATERAL` for a `lookup`               | A correlated scalar subquery in the select list                                                                                                                                                                         |
| A derived table that reads the outer row         | MariaDB cannot correlate a derived table. A collected lookup aggregates in the subquery itself, an ordered nested query orders inside `JSON_ARRAYAGG`, and a change feed holds the logged row in a one-row `JSON_TABLE` |
| `=`, `<=>` and the orderings between JSON values | MariaDB compares JSON as text. Equality is `JSON_EQUALS(a, b) = 1`, and an ordering compares the kind's place in MySQL's JSON order, then the number, then the text                                                     |
| `ORDER BY` a JSON value                          | The same kind, number and text terms, so a value of no declared type sorts in MySQL's JSON order with or without an index                                                                                               |
| `REGEXP_LIKE(text, pattern, 'c')`                | `text REGEXP CONCAT('(?-i)', pattern)`. The JavaScript pattern is translated once for both engines' flavours, ICU on MySQL and PCRE2 on MariaDB                                                                         |
| `CAST('…+02:00' AS DATETIME)`                    | MariaDB drops a zone offset without a warning, so the module applies it with `CONVERT_TZ`                                                                                                                               |

`JSON_EQUALS` is always compared with 1. MariaDB 11.8 and 12.3 take `JSON_EQUALS(a, b)` to hold where it is NULL when it stands alone in a `WHERE` or a `CASE WHEN`, so a bare call would match a row whose field is absent.

`distinct()` and the dedup of a `group` compare documents by their text on both engines. MySQL stores an object's keys sorted, so two equal objects share one text there. MariaDB keeps the keys in the order they were written, so two objects that differ only in that order are both kept.

## Change feeds

Feeds capture changes with row triggers on both engines and never read the binary log, so MariaDB's binary log format and its GTIDs do not matter to them. With binary logging on, MariaDB refuses `CREATE TRIGGER` with the same errno 1419 as MySQL, and the same two remedies apply: `GRANT SUPER ON *.* TO` the account, or `SET GLOBAL log_bin_trust_function_creators = 1`. See [Change feeds](./change-feeds.md#what-the-account-needs). The test servers run MariaDB with `--log-bin`, so binary logging in the `MIXED` format and GTIDs are on in every test run.

The sequencer numbers the rows it picked by key, naming each one in its `UPDATE`. MariaDB would otherwise scan the log beside a `JSON_TABLE` of the ids and wait on the row of a transaction that is still open.

## External mode

| MySQL                                                                                  | MariaDB                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The catalog reports a JSON column as `json`                                            | The module reads `SHOW CREATE TABLE` for each readable table and treats a column checked by `json_valid` as JSON. `information_schema.CHECK_CONSTRAINTS` lists those checks only to an account granted the whole schema |
| `COLUMN_DEFAULT` holds a literal bare and marks an expression with `DEFAULT_GENERATED` | MariaDB quotes a literal and leaves an expression bare. The module reads both into MySQL's shape                                                                                                                        |
| `IS_VISIBLE` says whether the optimizer may use an index                               | MariaDB's `IGNORED` says the opposite                                                                                                                                                                                   |
| A violated `CHECK` is errno 3819                                                       | It is errno 4025, `CONSTRAINT `name` failed`                                                                                                                                                                            |
| An insert reads each generated `_id` back with a `SELECT`                              | The insert answers it with `RETURNING`                                                                                                                                                                                  |

MariaDB 11.8 answers `score = 5.5` on an `INT` column through an index on it with the rows that hold 5, and answers no row without the index. The module compares such a column with the operand's own type and answers no row. A native query that compares with a decimal literal does not.

## Performance

The nested-field benchmark in [`bench/RESULTS.md`](../bench/RESULTS.md) runs on MariaDB 11.8 and 12.3 beside MySQL and PostgreSQL. Its findings name each gap over 2x and its cause.
