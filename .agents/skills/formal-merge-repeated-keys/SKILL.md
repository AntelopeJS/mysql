---
name: formal-merge-repeated-keys
description: Generated-input check that merge(), key reads and update() of @antelopejs/mysql keep the last member of a key a stored object names twice, spelled with escapes, control characters and Unicode, nested 1 to 40 levels deep, on MySQL 8.4 and 9.7 and MariaDB 11.8 and 12.3, or fail as too deep and change no row. Use when a change touches merge(), the member lookup of a key, how a key is escaped or an object's members are listed (src/dialect/mysql/sql-last-members.ts, src/dialect/mariadb/escaped-keys.ts, containers.ts, json-text.ts, src/implementations/database/member.ts), or needs proof that a merge never loses a value or keeps the wrong one.
---

# Formal check: merge and key reads on repeated keys

MySQL keeps only the last member of an object that names one key twice when it stores the document. MariaDB stores every member as written, so `{"é": "x", "é": "g"}` holds two members there, and the module rebuilds MySQL's answer. `docs/mariadb-repeated-keys.md` states the promise: a merge keeps the last member once, and a merge whose operand MariaDB 11.8 cannot list fails as nested too deep, changing no row.

**The property.** For a stored row with two generated objects `o` and `p`, each holding keys with escapes, control characters, Unicode and a key written twice in different spellings, nested from 1 to 40 levels, every read agrees with a JavaScript reader that parses the text and keeps the last member of each key: `o` and `p` as the whole document, `o.merge(p)`, `o.merge(<constant>)`, a constant key and a computed key of a merge, and, where the object names no key twice, a member and a path of 40 hops of the stored `o`. An `update()` that stores the merge writes that value, or fails as nested too deep and leaves the row's text as it was.

**The harm.** A merge that loses a value, or keeps an earlier member of a repeated key, writes the wrong document back into a row and reports success.

## Run it

From the repository root, with Docker running:

```sh
node .agents/skills/formal-merge-repeated-keys/check.mjs          # 150 scenarios
node .agents/skills/formal-merge-repeated-keys/check.mjs --full   # 1000 scenarios
```

`--runs <n>` and `--seed <n>` override the bounds and the seed. The check builds the module, then runs `src/test/formal-key-merge.test.ts` with `ajs module test`, against the server in `MYSQL_TEST_URL` or else a container of `MYSQL_TEST_IMAGE` (default `mysql:8.4`). It prints nothing when the property holds. It exits 1 and prints `BROKEN MergeKeepsLastMember`, the seed, the two objects as written and what each side read; it exits 2 when it could not run. `pnpm test` runs the same file on all four images.

| Bounds | Scenarios | Wall time on one engine |
| --- | --- | --- |
| `pnpm test` and the default | 150 | 1 s on MySQL, 3 s on MariaDB 11.8, 6 s on 12.3 |
| `--full` | 1000 | 6 s on MySQL, 17 s on MariaDB 11.8, 40 s on 12.3 |

`src/test/json-keys.ts` draws each object from a seed: one to three members a level, a chain of objects under the key `é` down to the drawn depth, each key spelled literal or as `\uXXXX` in upper or lower case, a key named twice in 40% of the levels and always at the deepest level half the time. The reference is `JSON.parse` of the same text, whose later member of a key wins. fast-check does not typecheck under this repository's `tsconfig`, so a seeded generator replaces it.

## What the check holds to

| Read | Holds when |
| --- | --- |
| `get()` of the row | `o` and `p` read as the reference reads them |
| `o.merge(p)` and `o.merge(constant)` | The object equals `{...o, ...p}` of the reference |
| `.key(k)` and `.key(computed)` of a merge | The member is the reference's, or absent |
| `key(k)` and 40 hops of `key("é")` of the stored `o`, where `o` repeats no key | The member is the reference's |
| `update()` that stores `o.merge(p)` | The stored value equals the merge, or the update failed as nested too deep and the row's text is unchanged |
| A document the server refuses to store as nested too deep | No row is stored |

A read may fail as nested too deep only on MariaDB 11.8, for a pair whose deeper object has 30 levels or more.

## Findings

None at the sync commit. Every property holds on all four engines for 1500 scenarios.

A read of a member of the stored `o` that names a key twice is not checked: `docs/mariadb-repeated-keys.md` documents that MariaDB reads the first member spelled as the path spells it there, so that read is a documented difference and not a promise.

## Scope and assumptions

| Covers | What it holds to |
| --- | --- |
| `src/dialect/mysql/sql-last-members.ts`, `src/dialect/mariadb/escaped-keys.ts`, `containers.ts`, `json-text.ts` | the SQL that lists an object's members and keeps the last of each key |
| `src/implementations/database/member.ts`, `stages-object.ts`, `paths.ts` | the key lookup and the merge stage |

Sync commit: `0328962`. Move it forward only after you confirm the check still describes the covered code at the new commit.

- Only MySQL 8.4 and 9.7 and MariaDB 11.8 and 12.3 are run, one at a time.
- A leaf is a string, a boolean, a null or a one-element array of one; no number is drawn, since `formal-json-value-identity` covers numbers.
- On MariaDB a plain ASCII key is never written escaped: `docs/mariadb.md` says the key is then not read there, and no common JSON writer does it. A key with a non-ASCII character, `/`, `<`, a quote, a backslash or a control character is escaped half the time.
- One row of two objects and one constant a scenario; no index, no declared field, no cursor, no feed.

## Confirm the check can fail

| Scratch change | Result |
| --- | --- |
| Run the file at `567cf05`, the parent of the fix that keeps the last member where a merge rebuilds an object on MariaDB (#57), with this folder's files copied in | MariaDB 11.8, seed 20261117: `merge of two stored objects: read [{"a":"first","a/b":null,…,"é":null}]`, where the reference has `"é"` holding the nested object |
| In `LastMembers` of `sql-last-members.ts`, read `MIN` of a key's ordinals instead of `MAX` | MariaDB 11.8, seed 20261118: `merge of two stored objects` reads the first member |

Drop each change and confirm the check is back to exit 0.
