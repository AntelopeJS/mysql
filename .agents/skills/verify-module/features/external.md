---
covers:
  - src/dialect/external.ts
  - src/dialect/mysql/external.ts
  - src/dialect/mysql/external-types.ts
  - src/dialect/mysql/external-checks.ts
  - src/implementations/database/external-schema.ts
  - src/implementations/database/external-catalog.ts
  - src/implementations/database/external-types.ts
  - src/implementations/database/external-row-source.ts
  - src/implementations/database/external-payload.ts
  - src/implementations/database/external-writes.ts
  - src/implementations/database/external-insert.ts
  - src/implementations/database/external-write-shared.ts
  - src/implementations/database/external-errors.ts
  - src/implementations/database/external-refusals.ts
docs:
  - docs/external-mode.md
  - docs/errors.md
journeys:
  - external-read-write
  - external-registration
  - external-read-write-mariadb
  - external-registration-mariadb
---

# External mode

An external instance on a client database the module does not own, connected as an account that reads every table and writes one.

## Sub-features

- `external-read-write`: rows read under their own column names with `_id` as the key's text, a `BIGINT` declared `string` as its exact text, a generated column as its value and a `TIMESTAMP` as its instant; an `ENUM` compares as its label; a view reads without a key; `insert` answers the generated `AUTO_INCREMENT` key; an `update` answers 1 when it changes the row and 0 when it does not; refusals of an undeclared payload key, a value too long for `VARCHAR(20)`, an unknown `ENUM` label, a value for a generated column, a write to a table the account was not granted (`ExternalWriteError` of kind `forbidden`), `changes()`, `createInstance` and `get` on a keyless view; `listInstances` answers `[]`; the `mysql` client shows the written rows and no `__antelope` table and no trigger in the client's database.
- `external-registration`: a declared column the table lacks fails registration naming the field and the column, and no query on the schema answers.
- `external-read-write-mariadb`, `external-registration-mariadb`: the same journeys on MariaDB 11.8.

## How to get to it (user POV)

- `mode: "external"` and the client's `url` in the module's config, and a schema declared with the database's own names, its id the client's database.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" external
```

## Gotchas

- The `sales` database, the `verify_reader` account and their rows are created by the `mysql` client as root, never by the module; the service's `reset` drops them before each journey.
- An `AUTO_INCREMENT` key accepts an explicit value in MySQL, so the read-only refusal is driven on a generated column instead.
