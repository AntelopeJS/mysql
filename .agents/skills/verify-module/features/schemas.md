---
covers:
  - src/dialect/ddl.ts
  - src/dialect/mysql/ddl.ts
  - src/dialect/mysql/catalog.ts
  - src/implementations/database/schema.ts
  - src/implementations/database/convergence.ts
  - src/implementations/database/migrate-tables.ts
  - src/implementations/database/migrate-indexes.ts
  - src/implementations/database/locks.ts
  - src/implementations/database/observe.ts
  - src/implementations/database/instances.ts
  - src/implementations/database/registry.ts
  - src/implementations/database/identifier.ts
  - src/implementations/database/types.ts
  - src/implementations/database/plan.ts
  - src/implementations/database/paths.ts
  - src/implementations/database/value-key.ts
  - src/implementations/database/ranked-key.ts
  - src/implementations/database/duplicate-key.ts
docs:
  - docs/storage.md
  - docs/indexes.md
  - docs/errors.md
journeys:
  - storage-layout
  - migrations
  - storage-layout-mariadb
  - migrations-mariadb
  - refused-unique-index
  - refused-unique-index-mariadb
---

# Schemas

What a registered schema becomes in MySQL, its instances, and how registration converges a changed declaration.

## Sub-features

- `storage-layout`: one table per schema table in the url's database, named `<schemaId>__<tableId>`, `utf8mb4_0900_bin` and signed in its comment; `_id` `varchar(512)` and `_instance` `varchar(128)`; the primary key `(_instance, _id)`; a number index on its own column led by `_instance`; a string index on a VIRTUAL `varchar(640)` key column holding `LEFT(value, 640)`; a `unique` index UNIQUE within the instance over a key column holding the exact value; a `crossInstance` index with its unprefixed `__g` twin, never unique; a `multi` index over a string array as a multi-valued `CHAR(512) ARRAY` index; a dotted index field `title.fr` keyed on a key column reading the nested JSON path; each index signed in its comment; `__antelope_instances` records each created instance; a taken unique key throws `DuplicateKeyError`; an instance id over 128 characters is refused; `CROSS_INSTANCE` reads every instance; `destroyInstance` deletes the instance's rows and keeps the table.
- `migrations`: a new field adds its column, moves the stored value out of `_extra` and clears the column's pending mark; under `safe` a changed type is refused naming the column and no read answers; under `destructive` the column is altered and a column no longer declared is dropped.
- `refused-unique-index`: `unique: true` added over rows that share a key. The server refuses the index, so an insert and an update that sets the indexed field are refused with an error that names the index and the server's message, and store nothing. An update of another field, a delete and a read go through. Once the rows are clean and the schema registers again, the index is built, an insert goes through and a duplicate throws `DuplicateKeyError`.
- `storage-layout-mariadb`, `migrations-mariadb`, `refused-unique-index-mariadb`: the same journeys on MariaDB 11.8, where columns are `utf8mb4_nopad_bin`, a document column is `longtext` checked by `json_valid`, and the `multi` index is left out with a warning that names it.

## How to get to it (user POV)

- `new Schema(id, definition)` in a consumer module, changed between two runs of `ajs project dev`, with `migrations` in the module's config.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" schemas
```

## Gotchas

- A new table is created with its indexes in the `CREATE TABLE`, so `storage-layout` finds them at once; it still polls `information_schema.STATISTICS` before it reads them, as an index phase on an existing table runs in the background.
- `information_schema` spells a key column's generation expression in the server's own form (`left(\`name\`,640)`, `json_extract(\`title\`,_utf8mb4'$."fr"')` on MySQL, without `_utf8mb4` on MariaDB), so the journey matches it with patterns.
- Concurrent convergence by several processes, a crash between statements, a step retried after a lock timeout, and online builds under write load are not driven: they need a second process or a crash mid-step. `src/test/convergence-contention.test.ts`, `crash.test.ts` and `index-phase.test.ts` cover them.
