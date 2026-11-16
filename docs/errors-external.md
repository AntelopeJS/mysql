---
title: Errors and refusals in external mode
description: Every input the MySQL module refuses in external mode, with the exact message it throws.
mode: reference
---

Everything this module refuses in external mode, on a database it was pointed at, with the message it refuses with. The module fills each placeholder in `{braces}` from what you passed. A `{relation}` is the relation's name in backticks, such as `` `sales`.`accounts` ``. See [External mode](./external-mode.md), and [Errors and refusals](./errors.md) for owned mode.

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

## External write errors

A value that does not fit its column, and a constraint the database enforces, surface as an `ExternalWriteError`. Its `kind` comes from MySQL's errno:

| Errno                        | `kind`       | Message                                                                                                                                                                   |
| ---------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| checked before the write     | `invalid`    | `Field '{path}' cannot hold {value}: {reason}`, one per field, joined by `; `                                                                                             |
| 1264, 1265, 1292, 1366, 1406 | `invalid`    | `Field '{schema}.{table}.{column}' cannot hold the value written: {detail}`                                                                                               |
| 3854                         | `invalid`    | `Field '{schema}.{table}.?' cannot hold the value written: {detail}`, for text a computed value holds that the column's character set cannot; `mysql:9.7` names no column |
| 1048, 1364                   | `missing`    | `Field '{schema}.{table}.{column}' of {relation} is required`                                                                                                             |
| 1062                         | `duplicate`  | ``A row of {relation} already has this value of unique `{constraint}`: Duplicate entry '…' for key '…'``                                                                  |
| 1452                         | `reference`  | ``A referenced row does not exist for `{constraint}` of {relation}: {database message}``                                                                                  |
| 1451                         | `referenced` | ``The row of {relation} is still referenced through `{constraint}`: {database message}``                                                                                  |
| 3819                         | `check`      | ``The row breaks check `{constraint}` of {relation}``                                                                                                                     |
| 1142, 1143                   | `forbidden`  | `The connected account may not write to {relation}: {database message}`                                                                                                   |

No layer maps an `ExternalWriteError` to an HTTP status, so a client sees it as a failed write that carries this message.
