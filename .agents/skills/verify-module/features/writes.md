---
covers:
  - src/dialect/error-types.ts
  - src/dialect/mysql/errors.ts
  - src/implementations/database/writes*.ts
  - src/implementations/database/payload.ts
  - src/implementations/database/coerce.ts
  - src/implementations/database/value.ts
  - src/implementations/database/transaction.ts
docs:
  - docs/storage.md
  - docs/behaviour.md
  - docs/errors.md
journeys:
  - insert-values
  - update-replace-delete
  - insert-values-mariadb
  - update-replace-delete-mariadb
---

# Writes

Writing documents into an owned instance and the column types they land in.

## Sub-features

- `insert-values`: an array insert resolves to one generated id per document; each declared type lands in its documented column type; an undeclared field round-trips through `_extra`; a `Date` under an undeclared key reads back as its ISO text; an `_id` over 512 characters fails with MySQL's `Data too long for column '_id'`; a named instance's document carries `_instance`.
- `update-replace-delete`: `update` keeps the fields it does not name and answers 0 when it changes nothing, `replace` clears them, `delete` removes the row, and inserting a taken `_id` throws `DuplicateKeyError`.
- `insert-values-mariadb`, `update-replace-delete-mariadb`: the same journeys on MariaDB 11.8, where a document column is `longtext` checked by `json_valid`.

## How to get to it (user POV)

- `table.insert`, `get(id).update/replace/delete` from a module that imports `@antelopejs/interface-database`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" writes
```

## Gotchas

- `atomicMutation`, upserts and expression mappers in `update` are not driven here; `src/test/atomic.test.ts`, `duplicate-key.test.ts` and the unit specs under `src/test/unit/writes.spec.ts` cover them.
