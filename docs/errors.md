---
title: Errors and refusals
description: Every input the MySQL module refuses, with the exact message it throws.
mode: reference
---

Everything this module refuses, with the message it refuses with. The module fills each placeholder in `{braces}` from what you passed. A `{relation}` in external mode is the relation's name in backticks, such as `` `sales`.`accounts` ``.

## Change feeds

| What you did                                                                   | Message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Awaited a feed instead of iterating it                                         | `A 'changes' feed must be the last stage of a query and must be iterated rather than awaited`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Put a stage after `changes()`                                                  | same message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Put an ordering or aggregating stage before `changes()`                        | `The '{stage}' stage cannot be used before 'changes': it needs a total order or a finite relation, and a change feed is neither`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Stalled past the retention window                                              | `change feed on '{schema}.{table}' fell behind the retention window (changeRetentionMs): events {from} through {to} were reaped before it read them, so it cannot continue; re-open the feed`                                                                                                                                                                                                                                                                                                                                                                                 |
| Kept a feed open while the change log was created again, altered or emptied    | `change feed on '{schema}.{table}' cannot continue: the change log was recreated, altered or emptied, so the events it had not read may be gone; re-open the feed`                                                                                                                                                                                                                                                                                                                                                                                                            |
| Read a feed up to an event whose document nests deeper than the server builds  | `change feed on '{schema}.{table}' cannot deliver its next event after seq {seq}: the event's document nests deeper than the server builds a JSON document (100 levels on MySQL), so it cannot continue; re-open the feed to read on from the newest event`                                                                                                                                                                                                                                                                                                                   |
| Opened a feed with an account without `SUPER`, on a server with binary logging | `A change feed needs row triggers on the table, and MySQL refused to create one (errno 1419): the server has binary logging on, which lets only an account with the SUPER privilege create a trigger unless log_bin_trust_function_creators is 1. Either grant the account in the configured url that privilege (GRANT SUPER ON *.* TO the account), or set the variable on the server (SET GLOBAL log_bin_trust_function_creators = 1, and in its configuration file to keep it across a restart). See https://dev.mysql.com/doc/refman/8.4/en/stored-programs-logging.html` |

The refused stages are `orderBy`, `slice`, `nth`, `count`, `sum`, `avg`, `min`, `max`, `distinct`, `group`, `union` and `join`. Each is legal on the query one level out, which is why the message names the position as well as the stage. The four writes, `insert`, `update`, `replace` and `delete`, are refused before `changes()` too, with the same message. A write is refused because it writes and a feed reads, not because it lacks a total order.

The same message ends a registration that has to swap the triggers of a table that is already watched, after `Converging table '{table}' of '{schema}.{table}' failed at swapTriggers '{target}': `. See [What the account needs](./change-feeds.md#what-the-account-needs).

## Iterating a cursor

| What you did                                                | Message                                                                                                                                                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read a cursor that had been idle past `cursorIdleTimeoutMs` | `cursor {reqId} was reclaimed after {ms} ms idle (cursorIdleTimeoutMs) and cannot be resumed; re-run the query`                                                                                |
| Read a cursor whose ending is no longer remembered          | `cursor {reqId} has already ended and how it ended is no longer remembered, more than 1024 cursors having ended since; re-run the query`                                                       |
| Opened a cursor past `maxOpenCursors`                       | `cannot open another cursor: {n} are open, which is the maxOpenCursors limit of {max}; read one to its end or close it, or raise maxOpenCursors (it defaults to half of pool.connectionLimit)` |
| Read a cursor whose connection the server or network ended  | The driver's error, such as `Connection lost: The server closed the connection.` The cursor ends and gives its place under `maxOpenCursors` back                                               |

A cursor holds a pooled connection for as long as it is open, and a streaming `SELECT` holds a shared metadata lock that makes DDL on its tables wait. So the module reclaims a cursor that stops being read instead of letting it keep both. Both reclaim errors leave the whole query to be run again, where an exhausted or explicitly closed cursor reports that it is done. Answering `done` for a reclaimed cursor would cut your results short without a signal.

## Declaring a schema

| What you did                                             | Message                                                                                                                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declared `_instance` or `_extra` as a field, in any case | `Field '{name}' on '{table}' uses a reserved column name (_id, _instance, _extra); column names compare without case`                                                             |
| Declared `_id` as anything but `string`                  | `Field '_id' on '{table}' restates the adapter's key column and must be declared 'string'`                                                                                        |
| Used an unrecognised type token                          | `Unsupported field type '{token}' for '{path}'. Supported: string, number, boolean, date, object, any, optionally suffixed with [], a nested record, or an io-ts codec`           |
| Declared an array with more than one element type        | `Field '{path}' must declare exactly one element type, received {n}`                                                                                                              |
| Two fields that reach the same column name               | `Fields '{a}' and '{b}' on '{table}' both map to column '{column}'; rename one`                                                                                                   |
| Two tables, columns or indexes that reach the same name  | `The physical name '{name}' is claimed by both {a} and {b}; rename one`                                                                                                           |
| Declared a `unique` `multi` index over an array field    | `Index '{indexId}' on table '{table}' is unique and multi over an array field, whose elements MySQL cannot hold unique; drop one of the two flags`                                |
| Indexed a reserved column, or a path below one           | `Index '{indexId}' keys on '{field}', which reads the reserved column '{column}' the adapter owns; index a declared field instead`                                                |
| Indexed a path below a field with no members             | `Index '{indexId}' keys on '{field}', but '{owner}' is declared as a value with no members`                                                                                       |
| Declared an index whose fixed-width fields fill the key  | `Index '{indexId}' needs 512 bytes for the instance and {n} for its fixed-width fields, which leaves {m} of the 3072-byte key for {k} text field(s); drop a field from the index` |
| Changed a declared type under `migrations: "safe"`       | `Column '{name}' on '{table}' is {actual} but the schema declares {declared}; set migrations: "destructive" to alter it`                                                          |
| Pointed the adapter at a table it did not create         | `Table '{table}' already exists and was not created by @antelopejs/mysql for '{schema}.{table}'; rename or drop it, or set another schemaPrefix`                                  |
| A convergence step that kept failing                     | `Converging table '{table}' of '{schema}.{table}' failed at {step} '{target}': {cause}`                                                                                           |

A registration error fails the whole schema, and every query on it answers the same message. A tables-phase step fails registration when a lock it needs stays held for 6 attempts (`a lock it needs stayed held`), or when it runs and the catalog does not change (`the catalog did not change after it ran`). An index step that fails is logged as a warning that names it, and the next registration tries again.

## Selecting rows

| What you did                                               | Message                                                                                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Named an index that does not exist                         | `Unknown index '{indexId}' on '{schema}.{table}'`                                                                                                                                     |
| `between` on a compound index                              | `The 'between' stage ranges over one field, but '{name}' names {n}`                                                                                                                   |
| `between` on a field declared as an array                  | `The 'between' stage ranges over one value, but '{name}' holds a list`                                                                                                                |
| `getAll` key of the wrong arity for a compound index       | `The '{indexId}' index takes a key of {n} values, received {m} values`                                                                                                                |
| Used an index that keys on an array field alongside others | `The '{indexId}' index keys on an array field beside others, which no key addresses`                                                                                                  |
| `lookup` on a local key the schema does not declare        | `The 'lookup' stage takes its form from the local key's declared type, and '{key}' has none; declare it on the table, as an array to look up a list and as anything else for one row` |

`lookup` needs the declared type because it decides at compile time whether the key is a scalar or a list. An undeclared key has no type to read. A guess from the stored value could overwrite an array with a single miss, with no error.

## Writing

| What you did                                         | Message                                                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `insert` after any pipeline stage                    | `The 'insert' stage does not read the rows it is applied to, so every stage before it would be discarded: {stages}`                                          |
| A stage after a write                                | `The '{stage}' stage writes and can only be the last stage of a query`                                                                                       |
| Named `_extra` in a payload                          | `Payload key '_extra' is a column this adapter owns and no payload may write it`                                                                             |
| `update({})`                                         | `The 'update' stage was given a payload with nothing to write: name a field to set, or set one to undefined to remove it`                                    |
| Named `_id` in a payload over many rows              | `The '{stage}' stage was given a payload naming '_id' over a selection of many rows: address the row with get(_id) first, or leave '_id' out of the payload` |
| A mapper that returned nothing                       | `The '{stage}' stage was given a mapper that returned nothing: return the document the rows become`                                                          |
| Wrote a non-boolean into a declared `boolean` column | `{subject} takes a boolean or a JSON boolean for a boolean column, received {type}`                                                                          |
| `insert` or `replace` under `CROSS_INSTANCE`         | `The '{stage}' stage cannot write under CROSS_INSTANCE: name the instance the rows belong to, or omit the instance id for the default one`                   |
| A conflict mode other than `update` or `replace`     | `The 'insert' stage takes a conflict mode of update or replace, received {conflict}`                                                                         |
| A write nested inside another query                  | `The '{stage}' stage writes, so it cannot be nested inside another query`                                                                                    |
| A write read through a cursor                        | `The '{stage}' stage writes, so it cannot be read through a cursor`                                                                                          |
| An inserted document whose `_id` is not a string     | `An inserted document's '_id' must be a string, received {kind}`                                                                                             |
| A value wider than a unique index's text key holds   | `The value of '{field}' is longer than {w} characters unique index '{indexId}' on '{schema}.{table}' can hold`                                               |
| An `_id` over 512 characters                         | MySQL's errno 1406, `Data too long for column '_id' at row 1`                                                                                                |

### Duplicate keys

A write that would give a second row of an instance the key of a unique index throws the interface's `DuplicateKeyError`. Recognize it with `IsDuplicateKeyError(error)`. The module reads MySQL's errno 1062 and the key it names.

| What you did                                                        | `index`        | `fields`                    |
| ------------------------------------------------------------------- | -------------- | --------------------------- |
| `insert` of an `_id` the instance already holds, without `conflict` | `"_id"`        | `["_id"]`                   |
| A batch naming one `_id` twice                                      | `"_id"`        | `["_id"]`                   |
| `insert`, `update` or `replace` clashing on an index `unique: true` | the index's id | its `fields`, or `[the id]` |

Under `conflict: "update"` or `"replace"`, an existing `_id` is upserted, not refused. A clash on a unique secondary index is still refused. A batch `insert` stores none of its rows when any of them is refused.

`replace({})` is not refused. It clears every column it does not name, so it is a well-formed statement that empties the row. `update({})` writes nothing at all, and the module refuses it as shown under [Writing](#writing).

## Grouping

| What you did                                                                                                 | Message                                                                                                               |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `filter`, `orderBy`, `slice`, `nth`, `join`, `lookup`, `union` or a nested `group` inside a `group` callback | `The '{stage}' stage cannot appear in a group's sub-stream, though it is legal on the query outside the group`        |
| Two aggregates in one sub-stream, such as `stream.count().count()`                                           | `The '{stage}' stage cannot follow an aggregate in a group's sub-stream, since an aggregate may not read another one` |

## Instances and configuration

| What you did                                                                                                         | Message                                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Passed `CROSS_INSTANCE` to `createInstance` or `destroyInstance`                                                     | `{operation} does not accept CROSS_INSTANCE: pass a string id or omit it for the default instance` |
| Passed a non-string instance id to `createInstance` or `destroyInstance`                                             | `{operation} expects a string instance id, received {kind}`                                        |
| Passed an instance id over 128 characters to `createInstance` or `destroyInstance`                                   | `{operation} received an instance id longer than 128 characters, the most an instance id may hold` |
| A `cursorBatchSize`, `cursorIdleTimeoutMs`, `maxOpenCursors` or `change*` option that is not a positive safe integer | `{option} must be a positive safe integer, received {value}`                                       |
| A `statementTimeoutMs` that is not a non-negative safe integer                                                       | `statementTimeoutMs must be a non-negative safe integer, received {value}`                         |
| A `mode` other than `"owned"` or `"external"`                                                                        | `mode must be one of owned, external, received {mode}`                                             |
| A `dialect` other than `"auto"`, `"mysql"` or `"mariadb"`                                                            | `dialect must be "auto" or a supported engine, received {dialect}`                                 |
| A `pool` option the module sets itself                                                                               | `pool.{options} cannot be set: the module sets it itself`                                          |
| `mode: "external"` with no `url`, or an empty one                                                                    | `mode "external" needs a non-empty config.url; set it through the project's envOverrides`          |
| Queried with no configuration set                                                                                    | `MySQL adapter is not configured: construct() has not run yet`                                     |
| Queried with no pool open                                                                                            | `MySQL or MariaDB adapter is not connected: construct() has not run yet`                           |

Both suffixes name the common cause, not the only one. `construct()` clears the configuration and leaves no pool when it fails to reach the server. A query therefore answers these messages after a failed startup too, and after `destroy()`. An external instance that started without a connection answers `{engine} adapter is not connected: {reason}` instead, where `{engine}` is the engine `dialect` names, or `MySQL or MariaDB` under `auto`. See [A connection that fails at startup](./external-mode.md#a-connection-that-fails-at-startup).

## External mode

See [External mode](./external-mode.md).

| What you did                                                                   | Message                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Set `schemaPrefix`, `migrations` or a `change*` option with `mode: "external"` | `{options} cannot be set with mode "external": an external instance owns no tables, runs no DDL and keeps no change log`                                                   |
| Declared a table the database does not have, or the account cannot see         | `Table '{schema}.{table}' reads {relation}, which the database does not have, or which the connected account cannot see`                                                   |
| Declared a table the account can read only some columns of                     | `Table '{schema}.{table}' reads {relation}, which the connected account cannot SELECT from as a whole`                                                                     |
| Declared a field its relation has no column for                                | ``Field '{schema}.{table}.{field}' reads column `{field}`, which {relation} does not have``                                                                                |
| Declared a type the column cannot be read as                                   | ``Field '{path}' is declared {type}, but column `{column}` is {native type}: {accepted declarations}``                                                                     |
| Declared `_id` on a relation with no key                                       | `Field '{path}._id' aliases the relation's key, but {relation} has no primary key and no unique index over NOT NULL columns; remove it`                                    |
| Read a named instance                                                          | `{relation} is an external relation and has no instances, so instance '{id}' names nothing: read it through the default instance`                                          |
| `get`, `getAll` without an index, or `_id` named, on a relation with no key    | `{relation} has no primary key and no unique index over NOT NULL columns, so its rows have no _id and cannot be read by key: filter on a field, or getAll by a field name` |
| A write to a relation with no key                                              | same message                                                                                                                                                               |
| `atomicMutation`                                                               | `The 'atomicMutation' stage is not supported on {relation}, an external relation: its contract tells a missing field from a NULL one, which a column cannot`               |
| `update` with an expression mapper                                             | `The 'update' stage on an external relation takes a document, received {kind}; an expression mapper is not supported on external relations in this version`                |
| A payload key that is not a declared field                                     | `Payload key '{key}' is not a field of '{schema}.{table}': {relation} is an external relation, and only its declared fields can be written`                                |
| A value for a generated or `SET` column on `insert`                            | `Field '{path}' cannot be given a value: it is {why}, which the database fills`                                                                                            |
| `_id` and a key field disagreeing                                              | ``Payload of '{schema}.{table}' claims two values for key column `{column}`, through '{first}' and '{second}'``                                                            |
| An `_id` that does not spell a composite key                                   | `Payload key '_id' of '{schema}.{table}' is {value}, which is not a key of this relation: a key of {n} columns is spelled as a JSON array of their texts`                  |
| Left out a key column that only a `DEFAULT` expression fills                   | ``Key column `{column}` of {relation} has no value in the payload: give it one, since only an AUTO_INCREMENT key is answered back after an insert``                        |
| `changes()`                                                                    | `changes() needs the adapter's change log, which {relation} does not have: it is an external relation, and the adapter installs nothing on it`                             |
| `createInstance` or `destroyInstance`                                          | `The '{stage}' stage manages instances, and an external instance's relations have none: read them through the default instance`                                            |

### External write errors

A value that does not fit its column, and a constraint the database enforces, surface as an `ExternalWriteError`. Its `kind` comes from MySQL's errno:

| Errno                        | `kind`       | Message                                                                                                                                                                 |
| ---------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| checked before the write     | `invalid`    | `Field '{path}' cannot hold {value}: {reason}`, one per field, joined by `; `                                                                                           |
| 1264, 1265, 1292, 1366, 1406 | `invalid`    | `Field '{schema}.{table}.{column}' cannot hold the value written: {detail}`                                                                                             |
| 3854                         | `invalid`    | `Field '{schema}.{table}.?' cannot hold the value written: {detail}`, for text a computed value holds that the column's character set cannot; MySQL 9.7 names no column |
| 1048, 1364                   | `missing`    | `Field '{schema}.{table}.{column}' of {relation} is required`                                                                                                           |
| 1062                         | `duplicate`  | ``A row of {relation} already has this value of unique `{constraint}`: Duplicate entry '…' for key '…'``                                                                |
| 1452                         | `reference`  | ``A referenced row does not exist for `{constraint}` of {relation}: {database message}``                                                                                |
| 1451                         | `referenced` | ``The row of {relation} is still referenced through `{constraint}`: {database message}``                                                                                |
| 3819                         | `check`      | ``The row breaks check `{constraint}` of {relation}``                                                                                                                   |
| 1142, 1143                   | `forbidden`  | `The connected account may not write to {relation}: {database message}`                                                                                                 |

No layer maps an `ExternalWriteError` to an HTTP status, so a client sees it as a failed write that carries this message.
