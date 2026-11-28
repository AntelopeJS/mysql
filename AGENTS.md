# @antelopejs/mysql

The MySQL and MariaDB backend of AntelopeJS. It implements `@antelopejs/interface-database` on tables it owns, and `@antelopejs/interface-database-catalog` on an existing database it was pointed at (external mode). It runs on `mysql2`.

## Layout

- `src/index.ts` and `src/config.ts`: the module's entry and its configuration.
- `src/implementations/database/`: the Database interface, owned and external mode, change feeds included.
- `src/implementations/catalog/`: the catalog interface.
- `src/dialect/`: the SQL each engine takes, in `mysql/` and `mariadb/`.
- `src/probe*.ts`: the connection probe, exported as `dist/probe`.
- `src/test/`: tests against a live server, `*.test.ts`, with unit specs in `src/test/unit/`. `src/test-external/` holds the external-mode tests.
- `docs/`: user-facing reference, indexed in `README.md`. `bench/`: benchmarks.

## Tests

Every `*.test.ts` needs a real server. Build, then run one file:

```bash
pnpm run build
MYSQL_TEST_URL=mysql://root:<password>@127.0.0.1:<port>/mysql pnpm exec ajs module test . -f dist/test/<file>.test.js
```

Without `MYSQL_TEST_URL`, the run starts a `MYSQL_TEST_IMAGE` container, `mysql:8.4` by default. Prefix the command with `MYSQL_TEST_MODE=external` for a file of `dist/test-external/`. A change to SQL is proven on MySQL and on MariaDB. `pnpm test` runs every suite on four images in Docker, which is CI's job, one image per `Test` leg. `pnpm run test:unit` runs the unit specs with no server.

<!-- antelopejs-guardrails:start -->
<!-- Managed by @antelopejs/tooling-configs. `antelopejs-sync` rewrites everything between these markers; write repository-specific guidance outside them. -->

## Guardrails

CI runs `pnpm run checks` in full on every pull request and reports what failed. The commit hook formats and lints the staged files. Locally, check only what you touched, one test file and not the suite, as the [`verify-changes`](.agents/skills/verify-changes/SKILL.md) skill says.

### Comments

Say it in code: a constraint in a type, a lint rule or a test, a public item's contract in TSDoc. Other comments are lint directives naming their rules, `@ts-expect-error <reason>`, `SAFETY: <reason>` above a type assertion, and license or tool directives. A reason states what the code does now.

### Tests

Each test names the wrong implementation it fails on, or is deleted. Drive behaviour through the public interface. An invariant over many files is a lint rule.

### Review

No tool checks these:

- A type guard checks the nested elements and values it claims.
- A no-upward import rule rejects same-tier peers; probe it with an import.
- A finding only an evasion or a patched internal can trigger goes under Attention and never blocks.

### Suppressions

`guardrails.suppressions.json` caps lint directives, `@ts-expect-error`, `SAFETY:` comments and rules a lint config turns off. Over a cap, fix the code or remove another suppression of that kind; only the operator raises a number. After removing suppressions, run `pnpm run suppressions:update` and commit the file.

<!-- antelopejs-guardrails:end -->
