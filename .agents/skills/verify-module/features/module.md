---
covers:
  - src/*.ts
  - src/dialect/index.ts
  - src/dialect/types.ts
  - src/dialect/mysql/index.ts
  - src/dialect/mysql/session.ts
docs:
  - README.md
  - docs/configuration.md
  - docs/errors.md
journeys:
  - module-dev
  - config-refused
  - config-options
---

# Module

The module's lifecycle and configuration: loading as `local`, the options `construct` refuses and why, the default config, `pool` options, the session pin and `schemaPrefix`.

## Sub-features

- `module-dev`: as in [smoke](smoke.md).
- `config-refused`: `ajs project dev` exits and names the reason for an unknown `mode`, a `cursorBatchSize` of zero or a fraction, a negative `changeRetentionMs`, a negative `statementTimeoutMs`, an unknown `dialect`, a `pool` option the module sets itself (`pool.timezone`), an external instance without `url` or with owned-only options, and an owned instance whose server does not answer (the driver's `connect ECONNREFUSED host:port`: only an external instance where the catalog answers words the reason as a sentence).
- `config-options`: `antelopeJs.defaultConfig` is the documented url in `safe` mode; a `pool` option the url does not set (`connectAttributes`) reaches every pooled connection; every such connection carries the session pin (`collation_connection` `utf8mb4_0900_bin`, `time_zone` `+00:00`, `lc_messages` `en_US`, the strict `sql_mode`), read back from `performance_schema`; `schemaPrefix: "app_"` stores table `notes` of schema `verify-config` as `app_verify-config__notes` in the url's database.

## How to get to it (user POV)

- The module's `config` in `antelope.config.ts`, and `ajs project dev`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" module
```

## Gotchas

- `statementTimeoutMs`, `maxOpenCursors`, the cursor idle timeout and the change options other than the refusal are not asserted: no journey can observe them without a slow or stalled reader. `src/test/cursors*.test.ts` covers them.
- `dialect: "mysql"` is accepted and skips `SELECT VERSION()`; only the refusal of an unknown engine is driven.
