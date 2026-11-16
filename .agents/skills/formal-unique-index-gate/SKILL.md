---
name: formal-unique-index-gate
description: Interleaving check, with fast-check over a fake MySQL server on a virtual clock, that the write gate of a schema in @antelopejs/mysql never opens before its declared unique indexes exist, and that a registration converges on the open pool or refuses the writes it covers, under reconnects, server restarts, killed builds, lock timeouts, refusals and another process holding the convergence locks (Schemas.register in src/implementations/database/schema.ts, the tables phase in migrate-tables.ts, the index phase in migrate-indexes.ts, the phase locks in locks.ts, unbuilt-unique.ts, the planning rules of convergence.ts, and Connect and Disconnect in src/connection.ts). Use when a change touches any of those files or needs proof that a write can never store a duplicate of a declared unique key.
---

# Formal check: the unique-index gate

A write to a schema that declares a unique index waits at `WaitForUniqueIndexes` until the schema's index phase has built every unique index, or left it unbuilt for a reason it names (`refused` by the server, `locked` by a long transaction), and a write whose fields an unbuilt unique index covers is refused. `Schemas.register` converges the tables, then starts the index phase in the background, and both phases take a named lock per schema, so processes converge it in turn. A reconnect, a restart or a kill can stop the work at any statement, and the next registration finishes it from the catalog.

**The property.** Across `Schemas.register`, the tables and index phases, the retries of `WithPhaseLock`, `Disconnect` and `Connect`, server restarts and killed connections, lock timeouts and refusals, and another process holding the convergence locks, no write is let through the gate while a declared unique index is neither in the catalog nor named as unbuilt, so no two rows share a declared unique key, and every registration converges on the pool that is open or refuses the writes it covers.

**The harm.** A write let through before its unique index exists stores a duplicate of an email, an order number or a tenant key. The index later refuses to build over the duplicates, and nothing says which write stored them.

The check runs the real `Schemas.register`, `WaitForUniqueIndexes`, `Connect` and `Disconnect` of `src/`, compiled with this folder, over `driver.ts`, a `mysql2` pool of sessions of `server.ts`, a model of the server, with `clock.ts` standing in for the pauses of `node:timers/promises`: the check moves the virtual clock to the next pause once nothing else can run, so a run of minutes of retries takes milliseconds. A statement the server does not know stops the check with exit 2, so an edit to the SQL cannot pass unread.

- `check.mjs` compiles this folder and the `src/` it imports into a scratch folder with the repository's `tsc`, runs `check.ts` there and deletes the folder. It copies no code of `src/`, so it has nothing to keep in step.
- `check.ts` draws scenarios with a fixed seed. A scenario holds the server's state at the start (a fresh database, or a table that exists without its unique index), the schema's first registration, the faults and conditions of the server, and up to two events. Each runs once with no event, to count the server's statements, then once per placement of its events before those statements. The pinned scenarios, one per fix of the escape chain, run beside the drawn ones.
- `rules.ts` holds the scenario generator and the rules.
- `server.ts` is the model: a catalog of tables, columns and indexes, named locks, sessions, and the DDL the module issues, parsed from its text.

## Run it

From the repository root, with Node 22 or 24 and `pnpm install` done:

```sh
node .agents/skills/formal-unique-index-gate/check.mjs            # CI bounds, prints failures only
node .agents/skills/formal-unique-index-gate/check.mjs --full     # full bounds
node .agents/skills/formal-unique-index-gate/check.mjs --verbose  # also the trace of each finding and the rules that held
node .agents/skills/formal-unique-index-gate/check.mjs --pinned 3 # one pinned scenario, statement by statement
```

`--scenarios <n>` and `--seed <n>` override the bounds. No database is needed.

| Bounds | Scenarios drawn | Events | Placements of events | Runs | Wall time |
| --- | --- | --- | --- | --- | --- |
| CI (default) | 40, and 11 pinned | 0 to 2 | every statement for one event, every fourth for two | 4,829 | 4 s |
| Full (`--full`) | 120, and 11 pinned | 0 to 2 | every statement for one event, every second for two | 41,164 | 25 s |

- Exit 0 means every rule that held still holds and each finding still breaks.
- Exit 1 means a rule changed: a rule that held now breaks (`BROKEN`), or a finding now holds (`HOLDS`).
- Exit 2 means the check could not run: `tsc` failed or the server does not know a statement.

## The rules

| Rule | Holds when |
| --- | --- |
| `NeverOpensWithoutItsIndex` | A write the gate lets through finds, in the catalog, every unique index the schema's latest declaration plans, or finds it named as unbuilt. Judged for the runs in which the schema is registered once |
| `NeverOpensWithoutItsIndexWhenRegisteredAgain` | The same, for the runs in which the schema is registered again while it converges. This is the recorded finding below |
| `ConvergesOrRefuses` | A write that arrives once the run is quiet is answered, by letting it through or by refusing it, and does not wait for ever |
| `BuildsWhatALockHeldOff` | A unique index named as `locked` is built once the lock that held it off is gone |
| `ConvergesOnTheOpenPool` | A write refused after the pool changed is refused for a statement that failed on the pool now open, never for the failure of a pool that ended |
| `Disconnects` | `Disconnect` ends, however many builds and registrations it finds running |

## Findings

`NeverOpensWithoutItsIndexWhenRegisteredAgain` breaks on `next`. `WaitForUniqueIndexes` awaits the schema's `ready` promise as it stood when the write arrived, then reads `uniqueGates` for the schema. When the schema is registered again before the first registration's tables phase has ended, `initialize` of the first registration returns without installing a gate (`unconverged` no longer names it), the write's `ready` resolves, and `uniqueGates` holds no gate yet, so `(await gate)?.unbuilt ?? []` answers `[]` at once. The write is let through while the first registration's unique index, and the second's, are unbuilt: in the shortest counterexample, a write that waits at the first statement of a registration of `price` unique, with a second registration of `price` and `sku` unique right behind it, is answered after the first registration's tables phase, 25 statements before the index phase begins. The `gate !== uniqueGates.get(schemaId)` retry in the code covers a rejected gate and never an absent one. The check records it as `finding`; when a change closes it, the check exits 1 with `HOLDS`, and the finding leaves `FINDINGS` in `check.ts` and this section.

## Read a result

`BROKEN <rule>` or `finding <rule>` prints the scenario as JSON, the placement of its events, one line per statement the server ran (the session, the statement and its answer), what each write at the gate was answered and after which statement, then `=>` lines naming what broke. `--verbose` prints the trace of a finding too. The trace of the shortest counterexample is printed. Then decide whether the code or the model is wrong:

1. Find where the run leaves the property: the statement after which a write was let through, or after which nothing woke it. Find the function of `src/`: `WaitForUniqueIndexes` and `Schemas.register` in `schema.ts`, `BuildIndexes`, `RunIndexPhase`, `ConvergeIndexes` and `AgainWhenServerStops` in `migrate-indexes.ts`, `WithPhaseLock` in `locks.ts`.
2. Ask whether MySQL 8.4 would answer that statement as the trace says, in that state. "What the model assumes" lists each answer the server gives; the module's own `index-phase.test.ts`, `index-build-killed.test.ts`, `locked-unique-index.test.ts` and `refused-unique-index.test.ts` run the same cases on a real server. If the server would answer otherwise, the model is wrong: fix `server.ts` and rerun every row of "Confirm the check can fail".
3. Ask whether the events could happen: a registration can be called again at any time, a connection can be lost at any statement, and `Disconnect` and `Connect` come from the host.
4. Otherwise the code breaks the property. Report it with the trace, and do not weaken a rule or the model to make it pass. To record it as a known finding, add the rule to `FINDINGS` in `check.ts` and describe it under Findings.

## Scope and assumptions

What the check covers, at the sync commit:

| File | What runs | Functions |
| --- | --- | --- |
| `src/implementations/database/schema.ts` | the real code | `Schemas.register`, `Schemas.unregister`, `initialize`, `WaitForSchemaReady`, `WaitForUniqueIndexes`, `GetTablePlan` |
| `src/implementations/database/migrate-tables.ts` | the real code | `ConvergeTables`, `ConvergeTable`, `ApplyRegistry` |
| `src/implementations/database/migrate-indexes.ts` | the real code | `BuildIndexes`, `RunIndexPhase`, `RunPass`, `ConvergeIndexes`, `AgainWhenServerStops`, `StopIndexBuilds` |
| `src/implementations/database/locks.ts` | the real code | `WithTablesLock`, `WithIndexesLock`, `WithPhaseLock`, `Holding`, `OnDedicatedSession`, `Interrupt` |
| `src/implementations/database/unbuilt-unique.ts`, `convergence.ts` | the real code | `UnbuiltUnique`, `ReportUnbuilt`, `NextTableStep`, `NextIndexStep`, `HoldsUniqueIndexes` |
| `src/connection.ts` | the real code | `Connect`, `Disconnect`, `PoolGeneration`, `AcquireConnection` |

The scenarios register `items` with a string and a number field and one unique index (`price`), or two (`price` and `sku`, which needs a key column). The scheduler of the check starts the events, and the writes that wait at the gate are calls of `WaitForUniqueIndexes`; the check judges the catalog at the moment a write is answered, and does not run the insert it would go on to compile. A write that stores a duplicate is a write the gate let through while the index it needed was not in the catalog.

What the model assumes:

- A DDL statement that adds or drops an index is atomic and takes the server some time, here 2 s of virtual time, during which the connection can be killed or lost and the statement then changes nothing. A `KILL QUERY` of a statement that is not running does nothing. A connection lost after the statement ended leaves its change in the catalog and fails on the client (`lostAfter`).
- `ADD UNIQUE INDEX` fails with 1062 while rows hold the same key, 1071 when the key is too long, 1061 when another process built the index first and 1205 when a long transaction holds the table for longer than the session's `lock_wait_timeout`; a table held for less delays the statement without failing it. 1317 is a killed statement, and 1927 or a fatal error a lost connection.
- `GET_LOCK(name, 0)` answers 0 while another session holds the name, and a session that ends releases its names. A restart ends every session and releases every name, and leaves the tables.
- A table that exists without its unique index (a database an earlier release or an earlier declaration converged) takes the index from the index phase, and a fresh table takes it in its `CREATE TABLE`.
- Triggers are never present, so the tables phase never swaps them.

Left out, each covered by its own tests or not at all:

- A second process of this module running the same code: another process is modelled only by what it does to the server, holding a convergence lock, holding the table, or building the index first. Two processes writing through two gates are not run.
- The insert the write goes on to run, and the rows themselves: the check judges the gate, which is what keeps the duplicates out.
- Backfills and key-column retypes in the tables phase, change-log triggers, the instance registry and external mode.
- A declaration whose unique index is multi-valued or crosses instances.
- More than one schema, more than two events, and a server with more than one table.

## Confirm the check can fail

Each row was run under the CI bounds, in a scratch worktree of the commit named, with this folder copied in. A row that names a fix runs the code of that fix's parent; the others are a scratch change to `src/` at the sync commit, and with it dropped the check exits 0 with the finding only.

| Code | Result |
| --- | --- |
| Before #20 (`f255e65`) | `BROKEN NeverOpensWithoutItsIndex`, `BROKEN ConvergesOnTheOpenPool` |
| Before #22 (`b0c9793`) | `BROKEN NeverOpensWithoutItsIndex` |
| Before #23 (`d8842a8`) | `BROKEN NeverOpensWithoutItsIndex`, `BROKEN ConvergesOnTheOpenPool` |
| Before #25 (`b440fb8`) | `BROKEN NeverOpensWithoutItsIndex` |
| Before #29 (`d45de90`) | `BROKEN NeverOpensWithoutItsIndex` |
| The gate opens before the first pass of the index phase (migrate-indexes.ts, `open([])` before `RunPass`) | `BROKEN NeverOpensWithoutItsIndex` |
| An index phase the server stopped is not tried again (migrate-indexes.ts, `AgainWhenServerStops` answers false) | `BROKEN NeverOpensWithoutItsIndex` |
| A refused unique index is not named as unbuilt (unbuilt-unique.ts, `CAUSES` without `refused`) | `BROKEN NeverOpensWithoutItsIndex` |
| A locked index that is still locked drops out of the gate (migrate-indexes.ts, `next` without `converged.unbuilt`) | `BROKEN NeverOpensWithoutItsIndex` |
| A stopped index phase opens the gate (migrate-indexes.ts, no `refuse(INDEX_BUILD_STOPPED)`) | `BROKEN NeverOpensWithoutItsIndex` |
| A registration of an ended pool is not registered again (schema.ts, `WaitForSchemaReady` returns `ready` for a stale one) | `BROKEN ConvergesOnTheOpenPool` |

Each `BROKEN` run exited 1. The rules a run reports depend on the first scenario that breaks one, so a row lists what the check reached. Before #25 the gate answers nothing and before #29 it names a refused index without a cause, so those five rows ran with the one edit of `check.ts` that reads the unbuilt list as empty, or each as `refused`.

## Keep it in step

Sync commit: `0328962`. At that commit the model and the covered files above describe the same code.

When a change touches a covered file:

1. Run both bounds. A `BROKEN` rule is a bug in the change until the steps in "Read a result" show it is the model's. A `HOLDS` for the recorded finding means no run breaks it any more: remove it from `FINDINGS` and from Findings.
2. If the change is intended and changes a statement the code issues or what it reads from the catalog, update `server.ts`, and this file's assumptions.
3. Apply each row of "Confirm the check can fail" again, and update a row whose code moved.
4. Move the sync commit forward only once you have confirmed that the model describes the code at the new commit.

`antelopejs-verify formal` runs this check with `--full` when a diff touches a covered file or this folder, and CI runs the CI bounds through `extra-commands`. `.agents/skills/verify-module/verify.config.ts` lists it under `formal`.
