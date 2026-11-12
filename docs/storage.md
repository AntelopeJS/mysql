---
title: Storage and schema
description: What a registered schema becomes in MySQL, the field-type table, what reaches an index, and how registration converges.
mode: reference
---

How a registered schema becomes MySQL tables, which field types map to which column types, what reaches an index, and how registration reconciles the declared schema with the database.

## Storage layout

A registered schema produces ordinary tables, in the database the URL names, that you can inspect and query directly:

```sql
CREATE TABLE `shop__items` (
  `_id`       VARCHAR(512) NOT NULL,
  `_instance` VARCHAR(128) NOT NULL,
  `name`      LONGTEXT NULL,
  `price`     DOUBLE NULL,
  `paid`      TINYINT(1) NULL,
  `at`        DATETIME(6) NULL,
  `tags`      JSON NULL,                     -- declared "string[]"
  `title`     JSON NULL,                     -- declared "object"
  `_extra`    JSON NOT NULL DEFAULT (JSON_OBJECT()),
  `__k_name_3f1c9a02` VARCHAR(640) GENERATED ALWAYS AS (LEFT(`name`, 640)) VIRTUAL,
  PRIMARY KEY (`_instance`, `_id`),
  INDEX `name` (`_instance`, `__k_name_3f1c9a02`)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin
  COMMENT='antelopejs:1:table:["shop","items"]';
```

- **One database, prefixed table names.** Every table lives in the URL's database as `<schemaPrefix><schemaId>__<tableId>`. The module never creates a MySQL database per schema id, so its account needs rights on one database only. A name longer than MySQL's 64 characters keeps its first 55, then `_` and 8 hex digits of the SHA-256 of the whole name. Registration refuses two tables, columns or indexes that reach one name, and compares names without case, as MySQL does.
- **The table comment marks ownership.** `antelopejs:1:table:` and the schema and table ids, as JSON. Registration refuses a table at the derived name that lacks this comment, so the module never converges a table it did not create.
- **`_id` is `VARCHAR(512)`.** Callers supply arbitrary strings such as `"user-123"`. When `_id` is absent, the adapter generates one with `node:crypto.randomUUID` before the statement runs, which is why `insert` answers the keys it created without reading anything back. An `_id` longer than 512 characters fails with MySQL's own error, `Data too long for column '_id'`.
- **`_instance` is the instance discriminator, `VARCHAR(128)`.** It holds `''` for the unnamed instance, and it leads the primary key, so the primary key serves `WHERE _instance = ?` with no extra index, and `CROSS_INSTANCE` is the absence of that predicate. `createInstance` and `destroyInstance` refuse an id longer than 128 characters. The two widths keep the primary key at 2560 bytes, within InnoDB's 3072-byte key limit at four bytes per character. Every document that a read answers carries the instance it came from under `_instance`. A document of the default instance carries no `_instance` key at all.
- **`_extra` holds undeclared fields.** You may write a field that your schema does not declare, and it round-trips. It lives in `_extra`, not in a column of its own, with the consequences listed under [Behaviour worth knowing](./behaviour.md).
- **`_id`, `_instance` and `_extra` are reserved.** Declaring `_instance` or `_extra`, in any case, is an error at registration. Declaring `_id` restates the key column, and the adapter accepts it as `string` and no other type. It adds no column, and the field is dropped from the shape.
- **A write payload may name `_id` and `_instance`, but not `_extra`.** A payload's `_id` is an assertion about which row is written, not an assignment. The adapter drops a payload's `_instance`, because no write moves a row between instances. Naming `_extra` is an error at query time.
- **The adapter tracks instances in `__antelope_instances`**, in the same database, keyed by the prefixed schema id and the instance id. `destroyInstance` deletes the instance's rows from every table of the schema and the registry row in one transaction, and never drops a table.
- **The change log lives beside them**, in `__antelope_changes`, `__antelope_change_clock` and `__antelope_change_reaped`. Registration creates them. See [Change feeds](./change-feeds.md).

### One collation everywhere

Every table, every text column, `_id`, `_instance` and every key column is `utf8mb4_0900_bin`, and every connection sets the same collation for its literals and bound values. The choice follows from what the interface needs:

- **Binary.** Text compares and sorts by code point and is case-sensitive, so `eq("vase")` does not match `"Vase"`, and `"Vase"` sorts before `"bulb"`. The JavaScript string comparison the interface describes behaves the same way.
- **NO PAD.** Trailing spaces are significant. `utf8mb4_bin` is a PAD SPACE collation, so `"a"` and `"a "` would be one primary key there.
- **One collation on both sides.** A literal in another collation than its column's stops the index from serving the comparison. The server default, `utf8mb4_0900_ai_ci`, never reaches a comparison.

## Field types

The set of accepted tokens is closed and case-insensitive. `"date"` and `"Date"` both work.

| Declared                                 | Column type   | Notes                                                                                              |
| ---------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| `string`                                 | `LONGTEXT`    | Never indexed directly. An index reaches it through a key column                                   |
| `number`                                 | `DOUBLE`      | JavaScript numbers are float64, so this type is exact                                              |
| `boolean`                                | `TINYINT(1)`  | Read back as a boolean                                                                             |
| `date`                                   | `DATETIME(6)` | In UTC, since every connection is. Read back as a `Date`                                           |
| `object` or `any`                        | `JSON`        | No declared shape                                                                                  |
| nested record, such as `{ a: "number" }` | `JSON`        | The shape is kept for type inference and for the key columns of paths below it                     |
| `"string[]"` or `["string"]`             | `JSON`        |                                                                                                    |
| io-ts codec at the field root            | `JSON`        | The adapter records the codec and never calls it. The field is a plain `JSON` column with no shape |
| anything else                            | none          | Error at registration, naming the field                                                            |

A field name longer than 64 characters gets a shortened column name, as table names do. A column name is therefore not always the field name verbatim.

**A number in a JSON column is the exact double you wrote**, in an array, in `_extra` or in a value the server computes, and a negative zero stays negative. MySQL 8.4's JSON parser reads some doubles of 17 significant digits as a neighbour, and JSON text spells -0 as `0`, so a number never reaches the server as JSON text. Each one is bound as a `DOUBLE`, and an array a query computes, such as a `map` result, is assembled without printing its elements. A list or document that holds only strings, booleans, nulls and integers up to 2^53 is still bound as one JSON text, so a long list of keys stays one argument.

## Indexes

A declared index becomes a real InnoDB index named after its index id. Index names are per table in MySQL, so no table name is added. An id that reads as `PRIMARY` gets a digest suffix.

### Key columns

Every index part that is not a plain number, date or boolean column, and is not `_id`, is one or two generated `VIRTUAL` columns named `__k_<field>_<digest>`. The index keys on those columns, and the compiler names them in its SQL, so the index serves the query on every engine. A `VIRTUAL` column stores nothing in the row, and adding one is instant. Its comment, `antelopejs:1:key:…`, records everything its definition depends on, and its name carries a digest of that, so a changed definition is a new column.

| Index part                                                                                                                                                       | Key columns hold                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| a declared `string` field                                                                                                                                        | its text                                                            |
| a declared `number`, `date` or `boolean` field, or `_id`                                                                                                         | none: the index keys on the column itself                           |
| a path a nested record declares a scalar, such as `title.fr` below `{ fr: "string" }`                                                                            | the JSON value at that path, as text, a number or a boolean by type |
| any other field or path: an undeclared field such as `sku`, a path below `_extra` or an `object` field, or a whole `object`, `any`, nested-record or array field | a value key: the value's kind, then the value, in two columns       |

A key column over a path typed `string` holds only a JSON string. A number or a boolean stored there holds NULL, so a string constant never matches a number.

**A value key keys a value by its kind, then by the value.** Its two columns are:

- **Text:** a one-character tag for the value's kind, followed by a string's text, or by an object's or an array's canonical JSON text. A number or a boolean holds the tag alone. A null and an absent value hold NULL.
- **Number:** a number's value, 0 or 1 for false and true, and 0 for any other value, a null included. An absent value holds NULL.

The tags follow the order MySQL sorts JSON values in, so an index over a value sorts it as `orderBy` sorts the same field without one: absent values first, then nulls, numbers by value, strings by code point, objects, arrays, and booleans, false before true. A descending sort reverses that order. Objects and arrays come back in no defined order among themselves, as MySQL leaves them.

`getAll` and `between` over a value key compare JSON values, exactly as the same field without an index does. `getAll(5)` finds the number 5 and not the string `"5"`, `getAll(true)` finds `true` and not `"true"`, and `getAll(null)` finds a stored null and not an absent value. `between(low, high)` keeps the values from `low` up to `high` in the order above, so `between(9, "B")` keeps the numbers from 9 and the strings below `"B"`. The index narrows the rows: a string or a date through the text column, its bound tagged as strings are, and a number or a boolean through the number column where the text column holds that kind's tag. A `between` bound that is an object, an array or a null narrows to the kinds it spans, and `getAll` by such a key tests every row of the instance.

**A dotted index field is a nested JSON path.** In `fields: ["title.fr"]` the name is first looked up as a declared field. When no field has that exact name, the part before the first dot names a declared JSON field, and the rest is the path below it. When that part is not declared either, the whole name is a path below `_extra`. This differs from `@antelopejs/postgres`, which reads `title.fr` as one undeclared key literally named `title.fr`. A path into a declared field that has no members, such as a `string`, is an error at registration.

**Prefix or exact.** A text key column of an index without `unique` holds `LEFT(value, w)`: a write never fails because of the index, even on an undeclared field. A comparison it serves also tests the full value, and ordering is exact up to `w` characters. A text key column of a `unique` index holds the exact value at most `w` characters wide, because uniqueness needs the whole value. A wider write fails with a message that names the field, the width and the index. A value key's text column spends one of its `w` characters on the tag, so it holds `w - 1` characters of a string, or of an object's or an array's JSON text.

**Width budget.** InnoDB keys are at most 3072 bytes, and the module counts four bytes per character. Every key leads with `_instance`, 512 bytes. Each number or date part takes 8 bytes, a boolean 1, `_id` 2048, and a value key's number column 8. What remains is split evenly between the text parts, a value key's text column among them:

```text fragment
w = floor((3072 - 512 - fixed bytes) / 4 / text parts)
```

One text part gets 640 characters, two get 320 each, and a text part beside `_id` gets 128. A value key alone gets 638, the tag included. A third text part makes each narrower instead of being refused. Registration refuses only an index whose fixed parts leave no character for a text part.

**Key columns.** InnoDB keys one index on at most 16 columns. `_instance` takes one, a value key two, and every other part one, so an index can key at most seven fields of no declared type. The module does not build an index that needs more. Registration logs a warning that names the index and the count, the schema still registers, and its table and every other index are built. Queries that name the index read the rows themselves, so they answer the same, only more slowly. A `unique` index left out refuses no duplicate, and the warning says so. Declaring the type of some of its fields brings each of those to one column.

### Index kinds

- **Every index leads with `_instance`**, because every read that is not `CROSS_INSTANCE` carries `_instance = ?`. An index on `(_instance, price)` serves `_instance = '' AND price > 1000` as one range scan.
- **`crossInstance: true` adds an unprefixed twin** named `<index>__g` over the same keys without `_instance`, and that twin serves a `CROSS_INSTANCE` read of the index. Without the flag, such a read stays correct but cannot use the index well. The first `getAll`, `between` or `orderBy` that names the index under `CROSS_INSTANCE` logs one warning per index per registration.
- **`unique: true` makes the `_instance`-led index `UNIQUE`.** The key is unique within each instance, and two instances may share it. The `__g` twin is never unique. Rows that lack a field of the key hold NULL there and never conflict. A value key refuses two equal values of any kind, such as the number 7 twice or `true` twice, and never two nulls. The number 7 and the string `"7"` do not conflict. When a schema declares a unique index, its writes wait until the index phase has built it, so no write can store a duplicate before the index exists. They also wait while another process builds it, and not at all once the catalog already holds it. Reads never wait. A write that the index refuses throws `DuplicateKeyError`.
- **`multi: true` over one declared `string[]` field is a multi-valued index**, `CAST(JSON_EXTRACT(field, '$') AS CHAR(512) ARRAY)`. MySQL serves `value MEMBER OF (JSON_EXTRACT(field, '$'))` from it, and only that spelling: a test on the bare column reads just the index's `_instance` prefix. So `includes` on the field, and a `getAll` on the index, compile to the exact expression the index is built on, and the plan reads the elements part of the key on MySQL 8.4 and 9.7. The server uses the index for a constant element only. A `lookup` or a join that tests each row's value against a list column compares a column of another row, which MySQL never serves from a multi-valued index, and it scans the instance's rows. An `includes` on a value read from below a field is not on the index either, since the index holds the field's own elements. An element longer than 512 characters, or an element that is an object, fails its write, as MySQL answers for any multi-valued index. Registration refuses `unique` with `multi` over an array field. `multi` over any other field, an array of numbers included, is an ordinary index over the whole value.

### What reaches an index

A comparison (`eq`, `lt`, `le`, `gt`, `ge`) whose operand reads an indexed field or path names the key column that holds it, so its index narrows the rows, and a test of the value itself decides them. Over a value key, a comparison as a string names the text column, and one as a number or a boolean names the number column. An index never changes which rows match, only how fast they are found. `get`, `getAll` and `between` on an index use its key parts. `orderBy` on an index sorts by its key parts, so the index serves the order. `orderBy` on a prefix key column sorts rows that share their first `w` characters in no defined order.

Declaring a field and an index on it is the most useful thing you can do for query performance. A path that no index names is read with `JSON_EXTRACT` on every row.

## Schema convergence

Registration reconciles the declared schema with what the database holds.

| Change                                  | `safe` (default)                                    | `destructive`                           |
| --------------------------------------- | --------------------------------------------------- | --------------------------------------- |
| New table                               | `CREATE TABLE`, with its key columns and indexes    | Same                                    |
| New declared field                      | `ADD COLUMN`, then move its values out of `_extra`  | Same                                    |
| Declared type differs from the column   | Error naming the column                             | `MODIFY COLUMN`                         |
| Column exists, no longer declared       | Warning, column kept                                | `DROP COLUMN`, with the indexes over it |
| Key column missing                      | `ADD COLUMN … VIRTUAL`                              | Same                                    |
| Index missing                           | `ADD INDEX`, online                                 | Same                                    |
| Index definition changed                | `DROP INDEX` and `ADD INDEX` in one `ALTER`, online | Same                                    |
| Adapter-signed index no longer declared | `DROP INDEX`, online                                | Same                                    |
| Key column no index needs               | `DROP COLUMN`                                       | Same                                    |
| Index this adapter did not create       | Left alone, unless it holds a declared index's name | Same                                    |
| Watched table's columns changed         | New triggers, then the old ones dropped             | Same                                    |

A type mismatch is fatal under `safe` because it would otherwise be a failure at query time, silent until the first read. Dropping an index loses no data, which is why the index rows need no opt-in. Under `destructive`, MySQL converts the stored values itself, and a value it cannot convert fails the `MODIFY` and changes nothing.

**The adapter moves a new column's values out of `_extra`.** When you add a field to a schema that already has rows, the new column is added with the comment `antelopejs:1:pending`. The adapter then moves the existing values from `_extra` into it, 1000 rows per statement in key order, and clears the comment. Until it is cleared, the next registration moves values again, so a stop part way finishes on the next start. A value that the column cannot hold, such as a string under a declared `number`, a date string that names no real day, or a JSON `null`, stays in `_extra` and is not coerced. A read through the module does not answer it, because the declared column wins over an `_extra` key of the same name and the column is NULL. SQL still reads it in `_extra`.

**MySQL has no transactional DDL, so every step is one statement.** The adapter reads the catalog, plans the next step from what it finds, runs it, and reads the catalog again. Progress lives in the catalog only: the table comment, the pending column comment and the index comments. A process that stops after any statement leaves a table that the next registration finishes from where it is, and a test stops convergence after every statement of each kind of change and checks that the end state is the same. A step whose object another process already created or dropped counts as done.

**Tables and columns converge before the schema is ready. Indexes converge after it, in the background.** A schema answers queries once its tables, columns, backfills and triggers have converged. No query ever waits for a secondary index, and results never depend on whether one exists yet. The adapter builds a btree index with `ALGORITHM=INPLACE, LOCK=NONE`, so the table keeps taking reads and writes while the index builds. MySQL cannot build a multi-valued index that way, so a `multi` index builds with `LOCK=SHARED`, which blocks writes to the table until it is built. An index carries its signature as its comment in the statement that builds it, so there is no unsigned window, and a failed build leaves no index behind.

**A refused index statement is skipped, and the next registration tries again.** If you add `unique` to an index over rows that already share a key, the build fails with a duplicate. The adapter logs the failure, keeps the other indexes building, and the previous index, if any, keeps serving. Remove the duplicates, then restart.

**The adapter owns the indexes it signed.** It recognizes them by a comment that starts with `antelopejs:`. An unsigned index at a declared index's name is replaced, and an unsigned index at any other name is left alone. Give a hand-made index a name no declaration uses.

**Several processes may converge the same schema at once.** A named lock (`GET_LOCK`) per schema and database serializes the tables phase. The process that goes second waits for the first, reads the catalog again, and finds nothing left to do. The index phase takes a second named lock and waits for it in the background. A process that finds it held waits for the holder to finish, then reads the catalog and builds what the holder's plan left out, such as an index only its own schema declares. While a phase waits for either lock, it asks for it again every second on a pooled connection that it gives back at once, so convergence in another process never holds this process's connections, however many schemas wait for it. Each phase that holds its lock runs on a connection of its own, which releases the lock if the process dies.

**DDL waits at most 5 s for a metadata lock**, because every later statement on the table queues behind an `ALTER` that waits. A step that times out on a lock is retried with a growing pause, up to 6 attempts. A tables-phase step that still times out fails registration and names the step. An index step that still times out is skipped until the next registration. Shutting the adapter down stops a running index build with `KILL QUERY`, and the next registration builds it again.
