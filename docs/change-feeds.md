---
title: Change feeds
description: How the MySQL module's change feeds work, row triggers that fill one log with a commit-ordered sequencer and a pull-based reader, and what that design guarantees and cannot see.
mode: explanation
---

A change feed is row triggers that fill one log, a sequencer that numbers the log in commit order, and a pull-based reader. This page covers the ordering guarantee, the retention contract, and what a feed cannot see by design.

`table.changes()` returns an async iterable of `{ changeType, oldValue?, newValue? }`. You must iterate it, and it must be the last stage of a query.

```typescript fragment
for await (const change of table
  .filter((d) => d.key("price").lt(100))
  .changes()) {
  console.log(change.changeType, change.oldValue, change.newValue);
}
```

## Capture

The first feed on a table installs three `AFTER INSERT`, `AFTER UPDATE` and `AFTER DELETE` row triggers on it, named `ajs_chg_<signature>_i`, `_u` and `_d`. Each writes one row per changed table row into `__antelope_changes`, in the writer's own transaction, with an image of the row before the write, after it, or both. An image holds every stored column. A JSON column is logged as its JSON text, so a column holding SQL NULL and one holding a JSON `null` stay apart, and a value as deeply nested as MySQL stores still fits in the log. An `UPDATE` that leaves every column as it was logs nothing. Neither does the backfill that moves a newly declared field out of `_extra` into its column, since it changes no document.

A table with these triggers is watched, and stays watched: the adapter never removes them. From then on, every write to the table costs a log row, whoever the writer is, which makes a bulk insert into a watched table about five times slower. Writes made outside the module, with the `mysql` client or another application, are captured the same way.

Convergence keeps a watched table's triggers in step with its columns. The triggers log the columns MySQL's catalog lists for the table, not the fields a schema declares. So processes that declare different versions of one schema, as in a rolling deploy, plan the same triggers, and an older one never swaps out a column a newer one's feed reads. The trigger name carries a digest of the trigger bodies, so a changed column list is a set of new names. After the columns are added or retyped, and before values move out of `_extra` or a column is dropped, the adapter locks the table with `LOCK TABLES … WRITE`, creates the new triggers, drops the old ones and unlocks. Writes wait for the few milliseconds the lock lasts. A process that stops between the two leaves both sets in place, so a write is logged twice until the next registration, and never not at all.

## What the account needs

Creating a trigger takes the `TRIGGER` privilege, which [the README](../README.md#install) lists with the others. On a server with binary logging on, which is MySQL's default, it takes one more thing. MySQL treats a trigger as a stored program that the binary log replays, so it accepts `CREATE TRIGGER` only from an account that holds `SUPER`, unless the global `log_bin_trust_function_creators` is `1`. The rule is in MySQL's [Stored Program Binary Logging](https://dev.mysql.com/doc/refman/8.4/en/stored-programs-logging.html). A server run with the `mysql` image defaults, 8.4 or 9.7, has binary logging on and the variable at `0`.

An account with neither is refused with errno 1419. The feed's open fails, and so does any registration that has to swap the triggers of a table that is already watched, with an error that names both remedies:

- Grant the account `SUPER` with `GRANT SUPER ON *.* TO`. `SYSTEM_VARIABLES_ADMIN` and `SET_ANY_DEFINER` do not stand in for it, which the module's tests check on 8.4 and 9.7. MySQL has deprecated `SUPER`, but a trigger still requires it.
- Set `log_bin_trust_function_creators = 1` on the server, with `SET GLOBAL` and in its configuration file so the setting survives a restart. The variable applies to every stored program on the server, which is the trade a replicated server weighs. Setting it takes `SYSTEM_VARIABLES_ADMIN` or `SUPER`, so an administrator does it, not the module's account.

The module does not read `@@log_bin`, the variable or the account's grants first, and words the server's own refusal instead. A check could refuse an account whose `SUPER` comes through a role, which the module cannot see. The refusal also costs nothing: `CREATE TRIGGER` is the first statement of a swap after its lock, so a refused swap creates and drops no trigger and gives the table back.

## Ordering

A log row has no `seq` when it is written. A sequencer numbers the rows whose transactions have committed, in the order they were logged, under a lock on one clock row, and skips the rows of transactions still open. Those are numbered once they commit. So `seq` order is commit order, and a reader that has seen `seq = n` has seen every change numbered before it.

Per-row order is guaranteed. Two writers of the same row serialize on its lock, so the second one's log row is written, and numbered, after the first one committed. A long-running transaction delays only its own events: the writes committed while it runs are delivered without waiting for it, and its own arrive after it commits.

## Delivery

A feed opens in three steps: it installs the table's triggers if they are missing, numbers every committed row still waiting for a number, and takes the highest number as its watermark. A change committed before the open is not delivered. A change whose transaction is still open is numbered after it commits, so it is delivered. When nothing has numbered the log for a while, the open waits for that backlog, about 2 s for 100,000 rows.

A feed reads every event through the schema as it was registered when the feed opened. If the same process registers the schema again with a field it did not declare before, the open feed still reads that field from `_extra`, and once the backfill has moved it into its column, the feed's documents no longer show it. Re-open the feed to read the new declaration.

Each process that has a feed open runs one clock. Every `changePollIntervalMs`, 100 ms by default, it reads where the log stands, numbers what has committed, and wakes the feeds of the tables that have new rows. A write committed by this process ticks the clock at once, so its feeds see it without waiting. A write from another process is seen within one interval. A woken feed reads its table's rows above its watermark, `changeBatchSize` at a time. A feed that is not woken reads the log anyway after 5 s.

## Retention

Retention is a contract. Every owned instance runs a reaper that numbers the log, then deletes the numbered rows older than `changeRetentionMs`, five minutes by default. It runs twice per retention window, deletes at most 10,000 rows per transaction, and runs in one process at a time, under a named lock. A row's age counts from when it was numbered, which is about when it committed, so a long transaction's rows are not deleted the moment it commits.

The reaper records, per table, the highest `seq` it deleted. A feed whose watermark is below its own table's high-water has lost events, and it ends with an error that names the range it lost, so it never falls out of sync without a signal. A feed on a table nobody writes is never ended because another table's rows went.

The log is an InnoDB table, so it survives a server restart, and a restart ends no feed. A feed ends with a loss only if the log itself is created again, for example after someone dropped it. The clock row carries an epoch that changes then, and the feed's next read refuses.

## Filtered feeds

A filtered feed shows a row's whole lifetime. The adapter evaluates the predicate on both images of an event and delivers the event if either side matched. You see rows enter and leave the filter, as well as change within it. `changeType` describes what happened to the row, not to its membership, so entering and leaving are both `modified`. Compare `oldValue` and `newValue` to tell them apart.

`oldValue` and `newValue` follow the operation, not the filter. An `added` event carries no `oldValue` and a `removed` one no `newValue`, and the key is absent, not set to `undefined`. A `modified` event always carries both, also when one side no longer matches the filter. That is how you see what a row looked like before it left.

The stages accepted before `changes()` are `filter`, `map`, `pluck`, `without`, `key`, `default`, `get`, `getAll`, `between` and `lookup`. A `lookup` resolves against the other table as of delivery, not as of the event. On a feed, `get(k)` is the predicate alone.

## Feeds never time out

A quiet table and an abandoned consumer look the same to the adapter. A feed holds no connection between reads, so there is nothing to reclaim. Only two things end a feed: you close it, or it hits one of the losses above. A read that fails, for example on a dropped connection, is logged and tried again, because reading again from the watermark is idempotent.

## What a feed cannot see

`TRUNCATE` fires no row triggers, and neither does a destructive migration that retypes or drops a column. `destroyInstance` deletes rows with `DELETE`, so a watched table delivers a `removed` event for each of them, at the clock's next tick. An external instance has no change log, and refuses `changes()`.

MySQL refuses to write out a JSON document nested more than 100 levels deep, and a feed builds each event's document in SQL. A declared `object` or `array` field nested the full 100 levels is stored and logged, but the document around it is one level deeper, so a feed cannot deliver that event. Its reads fail and are tried again until the reaper deletes the event, and the feed then ends as fallen behind. An undeclared field, which sits in `_extra`, is delivered at every depth MySQL stores.

The contract has no `includeInitial`. A consumer that builds a mirror must open the feed first, then read the table, then remove duplicates. Reading first races the feed and loses every write in between.
