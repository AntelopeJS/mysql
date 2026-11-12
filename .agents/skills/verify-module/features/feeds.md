---
covers:
  - src/dialect/capture.ts
  - src/dialect/mysql/capture.ts
  - src/implementations/database/change-log.ts
  - src/implementations/database/change-loop.ts
  - src/implementations/database/feeds.ts
  - src/implementations/database/feed-poll.ts
  - src/implementations/database/feed-pipeline.ts
  - src/implementations/database/sequencer.ts
  - src/implementations/database/reaper.ts
docs:
  - docs/change-feeds.md
journeys:
  - change-feeds
---

# Change feeds

`table.changes()` on an owned instance: the row triggers, the log they fill, the sequencer that numbers it and the pull-based reader.

## Sub-features

- `change-feeds`: a feed opened before the writes delivers `added`, `modified`, `modified` and `removed` in order, with `oldValue` absent on `added` and `newValue` absent on `removed`, then an `added` for a row written with the `mysql` client while it is open; a filtered feed shows a row leaving its filter as `modified` and delivers nothing for its removal outside the filter; registration created `__antelope_changes`, `__antelope_change_clock` and `__antelope_change_reaped`; watching the table installed one `AFTER` row trigger per operation, named `ajs_chg_<signature>_<i|u|d>`.

## How to get to it (user POV)

- `for await (const change of table.changes())` in a consumer module.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" feeds
```

## Gotchas

- The feeds live in the consumer module between scenario requests (`globalThis.verifyFeeds`), so the client's write happens while they are open. The journey waits for the table's triggers in `information_schema.TRIGGERS` before it writes, and ignores events for the `seed` row.
- The client's write commits in another process, so the feed sees it at the next tick of the change clock, within `changePollIntervalMs`.
- Each scenario request aborts after 5 s, so the read of the delivered events polls for at most 4 s.
- Retention (`changeRetentionMs`), the reaper, the commit-order guarantee across open transactions and the trigger swap after a column is added are not driven: they need minutes or concurrent transactions. `src/test/feeds.test.ts`, `feeds-convergence.test.ts` and the unit specs `feeds.spec.ts` and `reaper.spec.ts` cover them.
