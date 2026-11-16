---
covers:
  - src/probe.ts
  - src/probe-line.ts
  - src/probe-options.ts
  - src/probe-worker.ts
  - src/dialect/external.ts
  - src/dialect/mysql/external-catalog.ts
  - src/implementations/database/external-catalog.ts
docs:
  - docs/probe.md
journeys:
  - probe-access
  - probe-access-mariadb
---

# Probe

`dist/probe`, which a tool loads outside the AntelopeJS runtime to check a URL and what its account may do.

## Sub-features

- `probe-access`, and `probe-access-mariadb` on MariaDB 11.8: a plain Node process requires `dist/probe.js` and probes the run's server as accounts with different grants: a `SELECT`-only account reads and does not write, also in an empty database; an account that may `CREATE` in an empty database writes, and the probe leaves no table behind; a URL with no database answers `unreadable: "no-database-named"`; a wrong password is refused as `credentials`, no password as `sign-in-required`; a port nothing listens on is `unreachable`.

## How to get to it (user POV)

- `require("@antelopejs/mysql/dist/probe").probe({ url, timeoutMs, signal })`, as [the probe's page](../../../../docs/probe.md) shows.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" probe
```

## Gotchas

- The refusals `host`, `database`, `database-denied` and `other`, the `ssl` and URL option rules, the worker and `socketPath` are not driven: they need a server configured otherwise. `src/test/probe*.test.ts` covers them.
- `src/dialect/external.ts` and the catalog files are covered here and by `external` and `catalog`: the probe decides read and write access with the catalog's own checks.
