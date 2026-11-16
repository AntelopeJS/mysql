---
name: formal-mariadb-read-warnings
description: Interleaving check, with fast-check over a fake MariaDB 11.8, that a read of @antelopejs/mysql (a plain read, a write, a cursor of one or more batches, a feed poll) never hands its caller a row MariaDB nulled for a document nested past its limit or cut at max_allowed_packet, and leaves no warning on the connection for its next statement (src/warnings.ts, the Read and Write of src/connection.ts, src/implementations/database/row-stream.ts, src/dialect/mysql/checked-rows.ts, the warnings syntax of src/dialect/mysql/capture.ts and the session pin of src/dialect/mariadb/index.ts). Use when a change touches any of those files or the way a read learns its statement's warnings, or needs proof that a MariaDB read never answers a wrong row.
---

# Formal check: MariaDB reads never hand over a cut value

MariaDB 11.8 answers SQL NULL, with warning 4040 listed beside it, where a JSON function builds a document of 32 containers, and cuts an aggregate at `max_allowed_packet` with warning 1260 where MySQL fails the statement. The module reads those warnings back: `WarnedFailure` after a read, `CutBehind` after a failed statement, and for a cursor, whose rows leave the server before the statement ends, a check written into the statement (`CheckedRows`) that fails before its first row, then a run counting the warnings to tolerate inside one snapshot (`CheckedBehind`, `OpenRowStream`). A feed's poll is a `Read`, so it takes the same path.

**The property.** For any read path (a run, a cursor of 1 to n batches, a feed poll, a write), any document depth or size around 31 containers and `max_allowed_packet`, and any write committed between the statements of a read, the caller receives exactly the reference rows or an error that names the limit (too deep, cut at `max_allowed_packet`, or more warnings than MariaDB lists), never a wrong row before the error, and the next statement on the connection answers.

**The harm.** A break hands an order, a payment or an audit row over as `null` or short, or fails an unrelated later read with an old read's warning, and nothing in the answer says so.

The check runs the real `Read`, `Write` and `OpenRowStream` of `src/`, compiled with this folder, over `driver.ts`, a `mysql2` pool of sessions of `engine.ts`, a model of the server. `driver.ts` replaces the one export `createPool` of `mysql2/promise` and hands the code a connection that is an instance of the callback driver's `PoolConnection`, so a cursor streams from it as it streams from the driver's. A statement the engine does not know stops the check with exit 2, so an edit to the SQL cannot pass unread.

- `check.mjs` compiles this folder and the `src/` it imports into a scratch folder with the repository's `tsc`, runs `check.ts` there and deletes the folder. It copies no code of `src/`, so it has nothing to keep in step.
- `check.ts` draws scenarios with a fixed seed and runs each once with no writer, then once per placement of its writers among the engine's statements: a writer commits before the n-th statement the engine runs, for every n. The pinned scenarios, one per fix of the escape chain, run beside the drawn ones.
- `rules.ts` holds the scenario generator and the rules.
- `engine.ts` is the model. A table of documents is the whole database, each with its nesting (`containers`), its size (`bytes`) and the harmless warnings computing it raises (`warns`).

## Run it

From the repository root, with Node 22 or 24 and `pnpm install` done:

```sh
node .agents/skills/formal-mariadb-read-warnings/check.mjs          # CI bounds, prints failures only
node .agents/skills/formal-mariadb-read-warnings/check.mjs --full   # full bounds
node .agents/skills/formal-mariadb-read-warnings/check.mjs --trace  # the pinned scenarios, statement by statement
```

`--scenarios <n>` and `--seed <n>` override the bounds, `--verbose` prints the rules that held. No database is needed.

| Bounds | Scenario size | Drawn scenarios | Pinned | Runs | Wall time |
| --- | --- | --- | --- | --- | --- |
| CI (default) | 0 to 3 rows, 1 to 2 operations, 0 to 1 writer | 150 | 12 | 912 | 3 s |
| Full (`--full`) | 0 to 3 rows, 1 to 3 operations, 0 to 2 writers | 200 | 12 | 11,965 | 2 min 40 s |

- Exit 0 means every rule that held still holds and each finding still breaks.
- Exit 1 means a rule changed: a rule that held now breaks (`BROKEN`), or a finding now holds (`HOLDS`).
- Exit 2 means the check could not run: `tsc` failed or the engine does not know a statement.

## The rules

| Rule | Holds when |
| --- | --- |
| `HandsOverTheReferenceRows` | The rows a read, or a cursor read to its end, hands over are exactly the rows an undamaged server would answer for one run of its statement; a cursor read in part, or one that failed, hands over a start of them |
| `FailsOnlyOnALimit` | A failing operation fails with the too-deep error, the `max_allowed_packet` error or the unlisted-warnings refusal, and a run of its statement reached that limit: no failure for a harmless warning, no `re-run the query` refusal |
| `NextStatementAnswers` | After each operation, a table-less read answers on every connection the pool can give, and every connection can be taken again |
| `WriteStoresNoCutValue` | A write that answers a row count stored no aggregate cut at `max_allowed_packet` and no null for a too-deep document |
| `Settles` | Every operation ends |
| `NeverWrongPastTheListedWarnings` | The four rules above, for the runs in which a statement raised more warnings than MariaDB lists at most (65,535). This is the recorded finding below |

## Findings

`NeverWrongPastTheListedWarnings` breaks on `next`. `SHOW WARNINGS` lists at most `max_error_count` warnings, which the session pin raises to its largest, 65,535, and a read finds a nulled document or a cut aggregate only among the listed ones. A read that raises more warnings than that, with the too-deep or cut warning past the 65,535th, is handed over as it came: a plain `Read` and a `Write` hand over a `null` row or store the cut value and answer success. A cursor fails with its unlisted-warnings refusal, which is correct. On `mariadb:11.8.9`, 70,001 rows that each raise warning 1292 and a last row whose `JSON_MERGE_PATCH` is too deep list 65,535 warnings of code 1292 and no 4040, while `@@warning_count` answers 70,002 and the row is `NULL`. The count is there: `Read` and `Write` could fail when `@@warning_count` passes what `SHOW WARNINGS` lists, as `CheckedBehind` does for a cursor. The check records it as `finding`; when a change closes it, the check exits 1 with `HOLDS`, and the finding leaves `FINDINGS` in `check.ts` and this section.

## Read a result

`BROKEN <rule>` or `finding <rule>` prints the scenario as JSON, the placement of its writers, one line per statement the engine ran (the session, the statement, what it answered and how many warnings it has raised), what each operation handed back, then `=>` lines naming what broke. The trace of the shortest counterexample is printed. Then decide whether the code or the model is wrong:

1. Find the statement after which the run leaves the property: a row handed over before the failure, a warning left listed, a failure for a warning no read fails on. Find the function of `src/` that issued it: `ReadFailingTooDeep` and `WriteOn` in `connection.ts`, `WarnedFailure`, `CutBehind`, `CheckedBehind` and `Listed` in `warnings.ts`, `Settle` and `Take` in `row-stream.ts`.
2. Ask whether MariaDB 11.8 would answer that statement as the trace says, in that state. "What the model assumes" lists each answer the engine gives and that each was read off a real server; replay the trace on `mariadb:11.8` when in doubt. If the server would answer otherwise, the model is wrong: fix `engine.ts` and rerun every row of "Confirm the check can fail".
3. Ask whether the scenario could happen: another session commits between any two statements, and a connection goes back to the pool with the warnings it holds.
4. Otherwise the code breaks the property. Report it with the trace, and do not weaken a rule or the model to make it pass. To record it as a known finding, add the rule to `FINDINGS` in `check.ts` and describe it under Findings.

## Scope and assumptions

What the check covers, at the sync commit:

| File | What runs | Functions |
| --- | --- | --- |
| `src/connection.ts` | the real code | `Read`, `Write`, `ReadFailingTooDeep`, `WriteOn`, `AcquireConnection`, `AcquireUncapped`, `ReleaseCapped`, `Discard`, `Connect` |
| `src/warnings.ts` | the real code | `WarnedFailure`, `CutBehind`, `CheckedBehind`, `Listed` |
| `src/implementations/database/row-stream.ts` | the real code | `OpenRowStream` and its `Settle`, `Take`, `Snapshotted`, `Ended`, `close` |
| `src/dialect/mysql/checked-rows.ts` | the real code | `CheckedRows`, `CheckFailed` |
| `src/dialect/mysql/capture.ts` | the real code, through `GetDialect()` | the `warnings` syntax, `tooDeep`, `cutAggregate` |
| `src/dialect/mariadb/index.ts` | the real code | the session pin the first statement of every connection runs, which sets `max_error_count` |

The statements the scenarios read and write are stand-ins for what the compiler writes: a `JSON_MERGE_PATCH` over each row, a `JSON_ARRAYAGG` over the table, a plain read of the column, an `UPDATE` that merges, an `UPDATE` that stores an aggregate. Each carries a literal that names what the engine must compute, and the real wrapper of a cursor (`CheckedRows`) and the real statements for warnings, snapshots and clearing are the code's own. The compiler's SQL for a read, and the feed's poll statement, are not run: `feed-poll.ts` only shapes the rows a `Read` answers.

What the model assumes, each read off a real `mariadb:11.8.9` session:

- A statement that reads a table, a derived table included (`SELECT 1 FROM (SELECT 1) AS cleared`), clears the session's warnings before it runs. A statement that reads none, a `SELECT 1`, `SET`, `START TRANSACTION`, `ROLLBACK`, `SHOW WARNINGS` or `SELECT @@warning_count`, leaves them listed.
- `JSON_MERGE_PATCH` of a document of 31 containers, wrapped one level, answers NULL and raises one warning 4040 for the row. A `JSON_ARRAYAGG` or `GROUP_CONCAT` past `max_allowed_packet` answers its value cut and raises warning 1260.
- `@@warning_count` counts every warning and error the statement raised, `SHOW WARNINGS` lists the first `max_error_count` of them (64 until the pin raises it), and a statement that failed lists its warnings and then its error, which counts.
- A cursor's statement is computed whole before its first row, so the check of `CheckedRows` reads the full warning count at the first row and, on a failure, no row has left. A statement of no row never evaluates it.
- A snapshot read (`START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY`) sees the table as it was when the snapshot started, and a write of another session between two statements is visible to any read outside one.
- An `UPDATE` in strict mode fails with 4040 where a read only warns, and changes nothing.
- A document nests too deep where its containers plus the statement's wrap reach 32; a size passes `max_allowed_packet`, 1,000 in the model, where the aggregate's length, its elements and their commas, passes it.

Left out:

- MySQL 8.4 and 9.7, which fail a too-deep statement themselves, and MariaDB 12.3, whose nesting limit is higher; the model has MariaDB 11.8's, the lower one that holds on both.
- Lost connections, `statementTimeoutMs`, the sort-buffer retry of `Out of sort memory`, and a cursor closed before it was read: `row-stream-close.test.ts`, `cursors-timeout.test.ts` and the sort-buffer tests cover them.
- `cursors.ts`'s batching and idle timeout, which sit above `OpenRowStream`: the scenarios drive `OpenRowStream` and its `next` directly.
- A write committed while a result streams, which no statement of the model can see, and more than one open cursor.
- The compiler's SQL, and the real size of a document: the model's documents are descriptors, and `max_allowed_packet` is 1,000 of them.

## Confirm the check can fail

Each row was run under the CI bounds, in a scratch worktree of the commit named, with this folder copied in. A row that names a fix runs the code of that fix's parent; the others are a scratch change to `src/` at the sync commit, and with it dropped the check exits 0 with the finding only.

| Code | Result |
| --- | --- |
| Before #41 (`5ab3b21`) | `BROKEN HandsOverTheReferenceRows`, `BROKEN WriteStoresNoCutValue` |
| Before #52 (`ad7bd5f`) | `BROKEN HandsOverTheReferenceRows`, `BROKEN WriteStoresNoCutValue` |
| Before #66 (`1908aa2`) | `BROKEN HandsOverTheReferenceRows`, `BROKEN WriteStoresNoCutValue` |
| Before #71 (`b7d0d79`) | `BROKEN HandsOverTheReferenceRows`, `BROKEN NextStatementAnswers`, `BROKEN WriteStoresNoCutValue` |
| Before #73 (`bd5ebd8`) | `BROKEN HandsOverTheReferenceRows`, `BROKEN NextStatementAnswers`, `BROKEN WriteStoresNoCutValue` |
| Before #79 (`2d0014e`) | `BROKEN HandsOverTheReferenceRows`, `BROKEN NextStatementAnswers`, `BROKEN WriteStoresNoCutValue` |
| Before #87 (`aebeeb3`) | `BROKEN HandsOverTheReferenceRows` |
| Before #90 (`9c1ac1d`) | `BROKEN HandsOverTheReferenceRows` (a cursor hands over the null row a write swapped in between its runs), `BROKEN FailsOnlyOnALimit` |
| Before #91 (`ba47b96`) | `BROKEN HandsOverTheReferenceRows`, `BROKEN FailsOnlyOnALimit` |
| `Listed` no longer clears what it lists (warnings.ts) | `BROKEN NextStatementAnswers` |
| The cursor's second run starts outside a snapshot (row-stream.ts, `isSnapshotted = true` for `await Snapshotted(connection)`) | `BROKEN HandsOverTheReferenceRows`, `BROKEN FailsOnlyOnALimit` |
| The session pin drops `max_error_count` (mariadb/index.ts) | `BROKEN HandsOverTheReferenceRows`, `BROKEN FailsOnlyOnALimit` |
| `CheckedRows` leaves every statement unchecked (checked-rows.ts) | `BROKEN HandsOverTheReferenceRows` |
| `WarnedFailure` lists no warning (warnings.ts) | `BROKEN HandsOverTheReferenceRows`, `BROKEN WriteStoresNoCutValue` |
| `WriteOn` skips its warning check (connection.ts) | `BROKEN NextStatementAnswers`, `BROKEN WriteStoresNoCutValue` |
| `CheckedBehind` tolerates one warning too many (warnings.ts, `raised` for `raised - 1`) | `BROKEN FailsOnlyOnALimit` |

Each `BROKEN` run exited 1. The rules a run reports depend on the first scenario that breaks one, so a row lists what the check reached.

## Keep it in step

Sync commit: `734eb7b`. At that commit the model and the covered files above describe the same code.

When a change touches a covered file:

1. Run both bounds. A `BROKEN` rule is a bug in the change until the steps in "Read a result" show it is the model's. A `HOLDS` for the recorded finding means no run breaks it any more: remove it from `FINDINGS` and from Findings.
2. If the change is intended and changes a statement the code issues or the answer it reads, update `engine.ts` to the server's answer, `check.ts` for a statement the scenarios write, and this file's assumptions.
3. Apply each row of "Confirm the check can fail" again, and update a row whose code moved.
4. Move the sync commit forward only once you have confirmed that the model describes the code at the new commit.

`antelopejs-verify formal` runs this check with `--full` when a diff touches a covered file or this folder, and CI runs the CI bounds through `extra-commands`. `.agents/skills/verify-module/verify.config.ts` lists it under `formal`.
