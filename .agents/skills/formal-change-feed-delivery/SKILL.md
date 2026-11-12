---
name: formal-change-feed-delivery
description: Exhaustive interleaving check, with fast-check and a partial-order-reduced step explorer, that a change feed of @antelopejs/mysql delivers every change committed after it opened, once and in per-row order, or ends with a loss error (the sequencer in src/implementations/database/sequencer.ts, the reaper in reaper.ts, the feed open and poll in feeds.ts and feed-poll.ts, and their SQL in src/dialect/mysql/capture.ts). Use when a change touches any of those files, the change log's statements, or needs proof that a feed never skips, repeats or reorders an event.
---

# Formal check: change-feed delivery

A row trigger writes each change to `__antelope_changes` without a `seq`, in the writer's transaction. A sequencer pass locks the clock row, takes the rows still without a `seq` whose transactions have committed (`FOR UPDATE SKIP LOCKED`), numbers them from the clock in log order, and moves the clock, in one transaction. A feed opens by running a pass and taking the clock's frontier as its watermark, then polls the rows numbered above it. The reaper numbers, then deletes the numbered rows past retention, and raises each table's high-water so a feed that missed them ends with a loss error. `docs/change-feeds.md` states the promise this check guards.

**The property.** A feed delivers every change committed on its table and instance after its open read the frontier, exactly once, two changes of one document in the order they committed, and nothing else, unless it ends with a loss error that names the range that went.

**The harm.** A break loses or repeats an order, a payment or an audit event for every consumer that mirrors a table from its feed, and nothing fails: the feed keeps running.

The check runs the real `ReadFeedEvent`, `Sequence` and `ReapOnce` of `src/`, compiled with this folder, against `server.ts`, a fake server. `innodb.ts` holds the log, the clock and the reaped table under READ COMMITTED: a transaction's changes stay pending until it commits, a plain read sees the committed version, and a locking read or a write of a row another transaction holds waits or skips it. `statements.ts` recognises each statement of `capture.ts` by its SQL text and `steps.ts` runs it as one indivisible step, as one statement is on the server. A statement the table does not know stops the check with exit 2, so an edit to the SQL cannot pass unread. fast-check draws the scenarios with a fixed seed, and `explore.ts` runs each one under every order of its steps that can change an outcome.

- `check.mjs` compiles this folder and the `src/` it imports into a scratch folder with the repository's `tsc`, runs `check.ts` there, and deletes the folder.
- `check.ts` runs a scenario: seeded changes, then writers, change-clock ticks, reaper passes and one feed, all started at once. Once every step has run, a last pass numbers what is left and the feed reads to the frontier. Then the rules judge the run.
- `rules.ts` holds the scenarios and the rules. `shards.ts` splits the scenarios across worker threads; the printed result does not depend on `--jobs`.
- `explore.ts` is the order explorer. Each step names the resources it reads and writes, and the explorer runs a second order only where two steps of different actors race on one resource (dynamic partial-order reduction with sleep sets, Flanagan and Godefroid, POPL 2005). An order that only swaps commuting steps reaches the same outcome, so it is skipped. A step whose lock another transaction holds is not enabled, as a statement waiting on a lock does not run.

## Run it

From the repository root, with Node 22 or 24 and `pnpm install` done:

```sh
node .agents/skills/formal-change-feed-delivery/check.mjs          # CI bounds
node .agents/skills/formal-change-feed-delivery/check.mjs --full   # full bounds
```

`--scenarios <n>`, `--orders <n>` and `--seed <n>` override the bounds; each takes a positive integer. `--jobs <n>` sets how many worker threads explore the scenarios; it defaults to the available cores, at most 4. No database is needed.

| Bounds | Scenario size | Scenarios | Orders per scenario, at most | Orders run | Cut short as covered | Scenarios cut at the cap | Wall time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CI (default) | 1 to 2 writers, 0 to 1 tick, 0 to 1 reaper | 100 | 20,000 | 61,830 | 40,608 | 2 | 22 s |
| Full (`--full`) | FULL_SIZE | FULL_SCENARIOS | FULL_ORDERS | FULL_RUN | FULL_COVERED | FULL_CUT | FULL_TIME |

Every scenario also draws 0 to 2 seeded changes, 1 to 2 writes per writer, and a `changeBatchSize` of 1 to 3. Times are with the default `--jobs` (4) on a shared 16-core machine, `tsc` included. A scenario cut at the cap ran that many orders, not all of them: its remaining orders are unchecked, and the output counts them.

- Exit 0 means every rule that held still holds, and each finding still breaks.
- Exit 1 means a rule changed: a rule that held now breaks (`BROKEN`), or a finding now holds (`HOLDS`).
- Exit 2 means the check could not run: `tsc` failed, a statement is not in `statements.ts`, or the model reached a state it does not cover.

## The rules

| Rule | Holds when |
| --- | --- |
| `DeliversEveryChange` | Every change committed on the feed's table and instance after the open read the frontier is delivered, unless the feed ended as lapsed at or below its `seq` |
| `DeliversOnce` | No change is delivered twice |
| `DeliversOnlyItsCommittedChanges` | Every delivered change committed, on the feed's table and instance |
| `SkipsChangesBeforeOpen` | No change committed before the feed's first read began is delivered |
| `KeepsRowOrder` | Two changes of one document are delivered in the order they committed |
| `LapsesOnlyOnLoss` | A feed ends as lapsed only when the reaper deleted a row of its table in the range it names, and ends with no other error |
| `Settles` | Every actor finishes: no statement waits forever and no pass fails |

A change that commits while the open runs, after the feed's first read began and before the open read the frontier, may or may not be delivered: the docs promise neither.

## Read a result

`holds` lists the rules that held, with the bounds. `BROKEN <rule>` or `finding <rule>` prints the scenario as JSON, the picks that replay its order, then one line per step: the actor, the statement in plain words, and what it answered. `=>` lines name what broke. The trace of the shortest counterexample is printed, the lowest scenario on a tie.

Then decide whether the code or the model is wrong:

1. Find the step where the run leaves the docs' promise, and the statement in `src/` that issued it. The labels name the `capture.ts` statement: `lock the clock` is `lockClock`, `select unnumbered rows` is `unsequenced`, `number ids` is `stamp`, `move the clock` is `advance`, `poll` is `poll`, `find what is past retention` is `reapThrough`, `raise the high-water` is `raiseReaped`, `delete through seq` is `reap`.
2. Ask whether MySQL 8.4 would answer that statement as the trace says, in that state. Check `steps.ts` against the MySQL reference for the clause in question: READ COMMITTED reads, `SKIP LOCKED`, the locks an `UPDATE`, `DELETE` or `INSERT ... ON DUPLICATE KEY UPDATE` takes. If MySQL would answer otherwise, the model is wrong: fix `steps.ts`, and rerun every row of the table below.
3. Ask whether the scenario could happen: the writers, ticks, reapers and feed are concurrent in production, and `check.ts` starts them as production does. A run that only a wrong scenario reaches is a modelling error too.
4. Otherwise the code breaks the promise. Report it with the trace, and do not weaken a rule or the model to make it pass. To record it as a known finding, add the rule to `FINDINGS` in `check.ts` and a line for it under Findings below.

A footprint that is too small in `steps.ts`, `server.ts` or `check.ts` makes the explorer skip orders. When you add or change a step, give it every resource its outcome depends on, and its blocked check every lock it waits on.

## Findings

None at the sync commit. Every rule holds under both bounds.

## Scope and assumptions

What the check covers, at the sync commit:

| File | What runs | Functions |
| --- | --- | --- |
| `src/implementations/database/feeds.ts` | the real code | `ReadFeedEvent`, `Advance`, `Open`, `Poll`, `Waited`, `Wake`, `Retire`, `CloseOneFeed` |
| `src/implementations/database/feed-poll.ts` | the real code | `PollStatement`, `ReadPoll` |
| `src/implementations/database/sequencer.ts` | the real code | `Sequence`, `SequenceOnce`, `Numbered`, `InSessionTransaction`, `ReadFrontier` |
| `src/implementations/database/reaper.ts` | the real code | `ReapOnce`, `ReapBatch`, `LockName` |
| `src/dialect/mysql/capture.ts` | its SQL, read by `statements.ts` | `lockClock`, `unsequenced`, `stamp`, `advance`, `frontier`, `poll`, `reapThrough`, `raiseReaped`, `reap` |
| `src/implementations/database/feeds.ts` | copied in `server.ts` | `LIVE.open`: a `Sequence` pass that waits for the clock, then `ReadFrontier` |
| `src/dialect/mysql/capture.ts` | modelled in `server.ts` | `Triggers`: each write inserts one log row in the writer's transaction, under the document's row lock |
| `src/implementations/database/change-loop.ts` | modelled in `check.ts` and `server.ts` | `Tick` is a `Sequence` pass that skips a busy clock; `Announce` is the wake step, which the explorer may run whenever the feed waits and the polled state moved |

The model assumes:

- InnoDB at READ COMMITTED with record locks only. Every statement of the log uses its primary key, its unique `seq` key or `tbl_seq`, and the sequencer and the reaper set READ COMMITTED first. A `DELETE` waits on a locked row whose committed or pending `seq` is in its range.
- A retention of 0, so the reaper may delete any numbered row on its next step. A longer retention only delays a deletion, so it reaches no state this one does not.
- The clock `UTC_TIMESTAMP(6)` reads only moves forward. Steps are independent of its exact value, which only the retention compares.
- A writer locks its documents in one order, so writers never deadlock each other. InnoDB would roll one back, and a writer that rolls back is drawn already.

Left out, each covered by its own tests or not at all:

- Trigger swaps under `LOCK TABLES` (`ApplyTriggerSwap` in `change-log.ts`) and convergence, which `feeds-convergence.test.ts` covers on a real server.
- A log recreated or emptied: the epoch never changes in a scenario, so the `restarted` ending is not reached. `feeds-log.test.ts` covers it.
- Lost connections, failed statements and retried polls: no statement fails in a scenario unless the code issues one the model refuses.
- Filtered feeds, `CROSS_INSTANCE` feeds and the documents a poll projects: every side matches, and its document carries only the change's label.
- More than one feed, and more than three writers, two ticks or two reapers.

## Confirm the check can fail

Each scratch change was applied to `src/` in a scratch worktree at the sync commit and run under the CI bounds; every run exited 1. With the change dropped, the check exits 0.

| Scratch change in the code | Result, CI bounds |
| --- | --- |
| `Poll` moves the watermark to the frontier after a full batch (feeds.ts:289-290) | `BROKEN DeliversEveryChange` |
| `Poll` moves the watermark to one below the last row of a full batch (feeds.ts:290) | `BROKEN DeliversOnce`, `BROKEN Settles` |
| `Poll` ends the feed when its watermark equals the high-water (feeds.ts:277) | `BROKEN LapsesOnlyOnLoss` |
| `ReapBatch` deletes without raising the high-water (reaper.ts:48) | `BROKEN DeliversEveryChange` |
| `unsequenced` numbers the newest row first (`ORDER BY id DESC`, capture.ts:262) | `BROKEN KeepsRowOrder` |
| `SequenceOnce` runs its statements outside a transaction (sequencer.ts:110) | `BROKEN LapsesOnlyOnLoss`, `BROKEN Settles` |
| `Numbered` skips a busy clock even when the feed's open asks to wait (sequencer.ts:77) | `BROKEN SkipsChangesBeforeOpen` |
| `Numbered` moves the clock one short of the rows it numbered (sequencer.ts:87) | `BROKEN DeliversEveryChange`, `BROKEN LapsesOnlyOnLoss`, `BROKEN Settles` |

The rules a run reports depend on the first scenario that breaks one, so a row lists what that scenario broke. The counterexample for `ReapBatch` without the high-water, under the CI bounds: writers w1 and w2 each log a row. The feed's open runs its pass before either commits, numbers nothing, and reads frontier 0. Both writers commit. The reaper's pass numbers both rows 1 and 2, then deletes them. The feed polls after seq 0, finds no row and no high-water, and moves its watermark to 2. Change w2.1 is never delivered, and the feed never ends.

Dropping `SKIP LOCKED` from `unsequenced` changes no outcome: under READ COMMITTED a plain read never sees another transaction's uncommitted rows, and the clock lock already serialises the passes.

## Keep it in step

Sync commit: `9417068`. At that commit the model and the covered files above describe the same code.

When a change touches a covered file:

1. Run both bounds. A `BROKEN` rule is a bug in the change until the steps in "Read a result" show it is the model's.
2. If the change is intended and changes what a statement says or what a covered function does, update `statements.ts`, `steps.ts`, `server.ts` or `check.ts` to match, and the coverage table above.
3. Apply each row of "Confirm the check can fail" again, and update a row whose code moved.
4. Move the sync commit forward only once you have confirmed that the model describes the code at the new commit.

`antelopejs-verify formal` runs this check with `--full` when a diff touches a covered file or this folder, and the CI bounds on the base. `.agents/skills/verify-module/verify.config.ts` lists it under `formal`, and CI runs the CI bounds through `extra-commands`.
