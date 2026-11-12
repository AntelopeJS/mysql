## Findings

This run measures the module after the changes below; "before" is the run of 2026-11-11. Numbers marked _scratch_ time hand-written variants, which are diagnostics and not module output, on a 100,000-row table seeded by SQL on a MySQL container of its own: median of 7 after a warm-up.

**Verdict.** Wherever a declared index can serve a question, MySQL now uses it, in every form the question takes: key chains, the decorators' localized read, `orderBy("<index>")`, `lookup` by path and `joinInner`. Each answers in 0.3 to 0.8 ms, against 20 to 80 ms for postgres' best correct form. Without an index, `joinInner` now hash joins like postgres, at 1.2× to 1.9× postgres instead of 23× to 41×. Every MySQL answer is now correct. MySQL still exceeds 2× on unindexed filters (2.2× to 3.7×), on the decorators' sort after `map` (2.4×) and on the unindexed `lookup` (10× to 13×). The causes are in sections 3, 4 and 6.

### 1. The decorators' fallback reaches the key column (filter 137 → 0.33 ms)

`unlockrequest` reads `fr` with `.default(en)`, which compiles to `COALESCE(NULLIF(<fr>, JSON null), <en>)`. Before, the result of a `default` carried no key column, so its comparison scanned 100,000 rows. Now a `default` keeps the key column of the read it falls back from, marked as holding the value only on the rows where it is set. Wherever `fr` is present the result is `fr`, and the key column is NULL on every other row. A comparison through such a key column adds the bound `(key = LEFT(CONCAT('2', v), w) OR key IS NULL)` before the exact test of the value. MySQL serves it as `ref_or_null` on `internalTitleFr`, reading 1 row: 0.33 ms on 8.4 and 0.35 ms on 9.7, against 137 ms before. This holds for every comparison operator and for chained defaults, and the answer is the one the value test alone gives.

### 2. `joinInner` joins the table itself (24× to 41× → 1.2× to 1.9×, and 0.7 ms indexed)

Before, every `joinInner` read 2,000,020 rows, 100,000 per review. The other side was a derived table of the stored columns only, so the condition could not name a key column. Its `_instance` equality on the primary key's prefix also made MySQL read the books by `ref` access, which it never hash joins.

Now a join against a whole table the adapter owns joins the table itself, with the instance as part of the join condition. Where the condition names a column that an index keys right after `_instance`, the instance stays an equality and the index looks each review's book up: `_id` for the primary key, or the key column of `titleFr` or `internalTitleFr`. Elsewhere the instance is spelled as a closed range over the same rows. MySQL then reads the instance once by a range scan and hash joins it, reading 100,020 rows as postgres does.

The proposed `IGNORE INDEX FOR JOIN (PRIMARY)` was not used: it also stops the primary key from bounding the hash join's build side to the instance. Scratch 8.4, 20 reviews:

| join, 100,000 books per instance                | one instance | five instances |
| ----------------------------------------------- | -----------: | -------------: |
| module before (derived table, `ref` on PRIMARY) |      1048 ms |        1051 ms |
| `IGNORE INDEX FOR JOIN (PRIMARY)`               |      57.5 ms |       161.6 ms |
| instance as a closed range (shipped)            |      66.3 ms |        68.0 ms |
| `_id` join, before / after                      | 0.5 / 0.4 ms |   0.5 / 0.3 ms |

The range must not reach a condition that an index serves. Through the key column, the equality form takes 0.4 to 0.6 ms and the range form 92 to 96 ms (scratch, 8.4 and 9.7).

In the run, the three unindexed joins fell from 1045, 1608 and 2745 ms to 63, 79 and 123 ms on 8.4, and the indexed ones from 1120 to 2810 ms to 0.70 to 0.73 ms. They are bound by one scan of the instance that evaluates the JSON read on every row, the cost of the matching unindexed filter (53, 68 and 111 ms) plus the hash join; section 3 covers it.

### 3. Unindexed scans: one JSON path, still read twice (heading filter 79 → 68 ms)

A nested read such as `key("_internal").key("data").key("title").key("fr")` used to compile to four chained `JSON_EXTRACT` calls. Each call built the intermediate subdocument before the next one read it. Now a JSON read carries its document and path, so one more key extends the path, and the whole read is one `JSON_EXTRACT(_extra, '$."_internal"."data"."title"."fr"')`. The key columns' generation expression reads the same way, so the compiler and the index read one spelling.

The type-guarded string read, `CASE WHEN JSON_TYPE(<read>) … THEN CAST(JSON_UNQUOTE(<read>)) END`, still evaluates the read twice. MySQL has no function that reads a JSON string, and NULL for every other kind, from one evaluation. Dropping the type test would let `eq("7")` match a stored number 7, which the contract forbids. Measured on scratch 8.4:

| `_internal.data.title.fr = v` on 100,000 rows                  |   median |
| -------------------------------------------------------------- | -------: |
| module before: four chained reads, twice                       |  75.3 ms |
| module after: one path, twice                                  |  63.0 ms |
| one path, once, without the type test (not the contract)       |  45.3 ms |
| one path, once, typed through `REGEXP_SUBSTR` of its JSON text | 100.9 ms |

In the run, the heading filter fell from 79.2 to 68.0 ms (8.4) and from 80.4 to 69.6 ms (9.7), 2.2× postgres' 30.7 ms. `title.fr`, a one-key path, stays at 53 ms; one untyped read of it takes 41.9 ms (scratch), against postgres' 20 ms.

The decorators' unindexed filter takes 111 ms, 3.6× postgres. Its string read evaluates the whole fallback twice. On scratch 8.4, one evaluation of `COALESCE(NULLIF(fr, null), en)` takes 60.7 ms and the module's read 106 ms.

Convergence keeps a key column generated with the chained read: its signature names what it holds, not how its expression is spelled. `src/test/key-upgrade.test.ts` checks it on both versions, over documents whose path runs through an array, a null, a scalar or a missing key.

### 4. Sorts after `map`: postgres sorts in parallel (decorators form 2.4×)

Postgres plans these as `Gather Merge` over three processes. With parallel query off it took 394 ms for `title.fr` (MySQL 204 ms) and 137 ms for the decorators' read (MySQL then 139 ms, now 131 ms). MySQL has no parallel sort, and no index can serve an `orderBy` after `map` on either server.

### 5. Wrong answers

- `orderBy("title.fr")` on a table that declares no index used to sort by the literal top-level key `title.fr`, so every row tied. MySQL now reads an undeclared dotted name as a nested path, the rule index fields and `lookup`'s other key already used: an exact declared name first, otherwise a path below its first segment. It sorts the 100,000 books correctly in 116 ms (8.4), and `orderBy("_internal.data.title.fr")` in 109 ms. `getAll`, `between` and `group` take names through the same function and follow the same rule.
- Postgres still answers every `path` form wrong: its indexes, `orderBy` and `lookup` read a dotted name as one literal `_extra` key, so its `lookup` finds no book. This is the documented difference, and the ratios use postgres' correct forms.

### 6. Unindexed `lookup` (10× to 13×)

Without an index, MySQL's `lookup` is a correlated `LIMIT 1` subquery per review that scans until it finds the book. That costs 501 ms for 20 reviews by `title.fr`, about half a scan each, and 650 ms by the `_internal` path (756 before). The slow log's `rows_examined` (40) leaves out rows read inside correlated subqueries. Postgres' only correct answer is the `joinInner` hash join (40 ms). With the declared index the lookup takes 0.67 to 0.70 ms. A `lookup` that hash joins and keeps the first match per review would close the gap; not measured.

### 7. A value key under `internalTitleFr`

It now keys `_internal.data.title.fr` with a [value key](../docs/indexes.md#key-columns): a string's bound is `key = LEFT(CONCAT('2', v), 638)`, still one `ref`. Its rows' medians stay below the previous run's p95, as `titleFr`'s do with an unchanged key.
