# Feature map

One file per feature. Every journey that reaches the server runs on MySQL 8.4 under its id and on MariaDB 11.8 under `<id>-mariadb`; `ENGINES` in `session.ts` lists the two. `covers:` lists the source globs it owns, `docs:` the pages a verdict judges, and `journeys:` the journeys it runs. `pnpm exec antelopejs-verify map` checks that every user-facing file is covered.

| Feature | What the user does | Journeys |
|---|---|---|
| [module](module.md) | An app developer configures the module and starts the project; a bad config refuses to start and says why. | module-dev, config-refused, config-options, config-options-mariadb |
| [schemas](schemas.md) | A consumer module declares a schema with indexes and instances, then changes it between runs. | storage-layout, migrations, storage-layout-mariadb, migrations-mariadb |
| [writes](writes.md) | A consumer module inserts, updates, replaces and deletes documents. | insert-values, update-replace-delete, insert-values-mariadb, update-replace-delete-mariadb |
| [reads](reads.md) | A consumer module filters, sorts, joins, groups and iterates documents. | read-queries, read-queries-mariadb |
| [feeds](feeds.md) | A consumer module follows `changes()` on a table while it and other writers write. | change-feeds, change-feeds-mariadb |
| [external](external.md) | The developer points an external instance at a client's database and reads and writes its rows. | external-read-write, external-registration, external-read-write-mariadb, external-registration-mariadb |
| [catalog](catalog.md) | A generator describes, profiles and samples the client's database through the catalog. | catalog-describe, catalog-refused, catalog-describe-mariadb, catalog-refused-mariadb |
| [smoke](smoke.md) | The fixed journey every verdict runs: load the module and write rows read back with the native client, on MySQL 8.4 and MariaDB 11.8. | module-dev, insert-values, insert-values-mariadb |
