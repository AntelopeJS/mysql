---
title: Indexes
description: How a declared index becomes a MySQL index, the key columns that let JSON paths and text reach it, and which queries it serves.
mode: reference
---

How each declared index becomes a MySQL index, the key columns behind it, and which queries reach it. [Storage and schema](./storage.md) covers the tables and columns the index is built on.

A declared index becomes a real InnoDB index named after its index id. Index names are per table in MySQL, so no table name is added. An id that reads as `PRIMARY` gets a digest suffix.

## Key columns

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

## Index kinds

- **Every index leads with `_instance`**, because every read that is not `CROSS_INSTANCE` carries `_instance = ?`. An index on `(_instance, price)` serves `_instance = '' AND price > 1000` as one range scan.
- **`crossInstance: true` adds an unprefixed twin** named `<index>__g` over the same keys without `_instance`, and that twin serves a `CROSS_INSTANCE` read of the index. Without the flag, such a read stays correct but cannot use the index well. The first `getAll`, `between` or `orderBy` that names the index under `CROSS_INSTANCE` logs one warning per index per registration.
- **`unique: true` makes the `_instance`-led index `UNIQUE`.** The key is unique within each instance, and two instances may share it. The `__g` twin is never unique. Rows that lack a field of the key hold NULL there and never conflict. A value key refuses two equal values of any kind, such as the number 7 twice or `true` twice, and never two nulls. The number 7 and the string `"7"` do not conflict. When a schema declares a unique index, its writes wait until the index phase has built it, so no write can store a duplicate before the index exists. They also wait while another process builds it, and not at all once the catalog already holds it. Reads never wait. A write that the index refuses throws `DuplicateKeyError`. When the server refuses to build the index, or a lock holds its build off past 6 attempts, the writes it would check are refused. See [A unique index the server refuses](#a-unique-index-the-server-refuses) and [A unique index a lock holds off](#a-unique-index-a-lock-holds-off).
- **`multi: true` over one declared `string[]` field is a multi-valued index**, `CAST(JSON_EXTRACT(field, '$') AS CHAR(512) ARRAY)`. MySQL serves `value MEMBER OF (JSON_EXTRACT(field, '$'))` from it, and only that spelling: a test on the bare column reads just the index's `_instance` prefix. So `includes` on the field, and a `getAll` on the index, compile to the exact expression the index is built on, and the plan reads the elements part of the key on MySQL 8.4 and 9.7. The server uses the index for a constant element only. A `lookup` or a join that tests each row's value against a list column compares a column of another row, which MySQL never serves from a multi-valued index, and it scans the instance's rows. An `includes` on a value read from below a field is not on the index either, since the index holds the field's own elements. An element longer than 512 characters, or an element that is an object, fails its write, as MySQL answers for any multi-valued index. Registration refuses `unique` with `multi` over an array field. `multi` over any other field, an array of numbers included, is an ordinary index over the whole value.

## A unique index a lock holds off

An `ALTER` waits for every transaction that has used its table, and the index phase gives each attempt 5 s. When a long transaction holds the table through 6 attempts, the phase logs a warning that names the index. It treats the index as unbuilt and goes on to the schema's other tables. The writes the index would check are then refused with this error, and every other write to the schema goes through:

```text fragment
Write refused: unique index '{indexId}' on '{schema}.{table}' is not built, because a transaction holds the table ({the server's message}), so a write that adds rows or sets {fields} could store the duplicate it exists to refuse. It is built once that transaction ends, and the write can be run again then
```

The phase then tries the index again, one attempt per pass, after a pause that doubles from 1 s up to 30 s. Each pass takes the schema's indexes lock and gives it back. A later pass waits at most 1 s for the lock, where the first pass waits 5 s per attempt, because every statement on the table, a read included, queues behind it while it waits. A read that the pool makes wait for a connection, such as one on another table while many reads queue, waits as long. Once a pass builds the index, it logs that the writes go through again, and they do. Nothing needs cleaning up. Unregistering the schema, or disconnecting, stops the passes. Registering it again ends them after their current statement, and the new registration's phase builds what it declares. When the transaction stored duplicates through another client meanwhile, the server refuses the build once the lock is gone, and the index becomes [a unique index the server refuses](#a-unique-index-the-server-refuses).

## A unique index the server refuses

The server can refuse to build a declared unique index. It refuses with errno 1062 when rows of one instance already share a key, and with errno 1071 when the key is longer than the server allows. The index phase logs a warning that names the index and quotes the server's message. It then builds the other indexes and ends. A refused build is not tried again until the schema registers again. A build that the server stops, by a restart, a `KILL` or a lost connection, is a different case: the phase tries it again on the pool, and writes wait for it.

Until a later registration builds the index, the writes that it would check fail with this error:

```text fragment
Write refused: unique index '{indexId}' on '{schema}.{table}' is not built, because the server refused it ({the server's message}), so a write that adds rows or sets {fields} could store the duplicate it exists to refuse. Remove the rows it refuses, then register the schema again
```

These writes are refused:

- every `insert`, upserts included, because every row it adds goes into the index;
- every `replace`, because it states every column;
- every `update` whose function returns a whole document, such as `update((row) => row.merge({ ... }))`, because it assigns every column. An `update` whose function returns an object literal assigns only the keys it names;
- an `update` or an atomic update that sets a field the index keys on. A field that no column declares is stored in `_extra`, so an index on such a field refuses every write that sets any undeclared field.

Reads, deletes and other updates that set none of the index's fields go through. The server checks a unique index only when a row enters it or its key changes, so these writes cannot store a duplicate. They stay open so that you can clean the table through the module.

To build the index:

1. Find the rows that share a key in one instance. The server's message quotes the first key it found. Group the table's rows by `_instance` and by the indexed columns. For a field that the index keys on through a `__k_` key column, `SHOW CREATE TABLE` names that column.
2. Remove or change the extra rows. A `delete` through the module works. An `update` that sets the indexed field is refused, so change those values with SQL.
3. Register the schema again, for example by restarting the process. Its index phase builds the index, and writes go through again. Each process keeps refusing these writes until it registers the schema again itself, even after another process has built the index, so restart every process that serves the schema.

## What reaches an index

A comparison (`eq`, `lt`, `le`, `gt`, `ge`) whose operand reads an indexed field or path names the key column that holds it, so its index narrows the rows, and a test of the value itself decides them. Over a value key, a comparison as a string names the text column, and one as a number or a boolean names the number column. An index never changes which rows match, only how fast they are found. `get`, `getAll` and `between` on an index use its key parts. `orderBy` on an index sorts by its key parts, so the index serves the order. `orderBy` on a prefix key column sorts rows that share their first `w` characters in no defined order.

Declaring a field and an index on it is the most useful thing you can do for query performance. A path that no index names is read with `JSON_EXTRACT` on every row.
