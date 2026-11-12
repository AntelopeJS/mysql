---
covers:
docs:
  - README.md
journeys:
  - module-dev
  - insert-values
  - insert-values-mariadb
---

# Smoke

The fixed journey every verdict runs, whatever the diff touches: load the module as `local` against the run's MySQL container, write documents through a consumer module and read the stored rows back with the `mysql` client.

## Sub-features

- `module-dev`: the pack's journey. As for every journey, the harness reruns the service's readiness command when it fails, so a MySQL that stopped answering ends it NOT VERIFIED, not FAIL.
- `insert-values`: as in [writes](writes.md).
- `insert-values-mariadb`: as in [writes](writes.md), on MariaDB 11.8.

## How to get to it (user POV)

- A project with `@antelopejs/mysql` and a module that imports `@antelopejs/interface-database`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" smoke
```

## Gotchas

- The service's `reset` drops and recreates the `verify` database, drops the `sales` database and the `verify_reader` account before every journey, so each starts from an empty server.
- The MySQL image initializes on a socket-only server before it listens on TCP, so the readiness command connects over `127.0.0.1`.
- The smoke feature covers no glob, so it never marks a file as mapped.
