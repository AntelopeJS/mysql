## Findings

This run measures the module after the changes below; "before" is the run of 2026-11-11. Numbers marked _scratch_ time hand-written variants, which are diagnostics and not module output. MySQL scratch: a 100,000-row table seeded by SQL on a MySQL container of its own, median of 7 after a warm-up. MariaDB scratch (sections 8 to 11): the bench's own tables, seeded through the module on containers of their own, one container per version, median of 7 for filters, 5 for the per-read costs and 3 for joins and sorts, after a warm-up; MySQL 8.4 ran the same statements as the reference.

**Verdict.** Wherever a declared index can serve a question, MySQL and MariaDB now use it, in every form the question takes: key chains, the decorators' localized read, `orderBy("<index>")`, `lookup` by path and `joinInner`. Each answers in 0.4 to 0.9 ms on MySQL and 0.4 to 1.6 ms on MariaDB, against 22 to 89 ms for postgres' best correct form. Without an index, MySQL's `joinInner` hash joins like postgres, at 1.0× to 1.6× postgres instead of 23× to 41×. Every MySQL and MariaDB answer is correct. MySQL still exceeds 2× on unindexed filters (2.2× to 3.6×), on the decorators' sort after `map` (2.2× to 2.3×) and on the unindexed `lookup` (8.5× to 12×); the causes are in sections 3, 4 and 6. MariaDB 11.8 and 12.3 meet the index threshold and miss the 2× threshold on 15 of the 26 cells, from 2.6× to 136×, and the two versions agree within 8% on every one of them. The causes are in sections 8 to 11: MariaDB's JSON is text, so each read costs more the larger the document, and it has no hash join.

### 1. The decorators' fallback reaches the key column (filter 137 → 0.36 ms)

`unlockrequest` reads `fr` with `.default(en)`, which compiles to `COALESCE(NULLIF(<fr>, JSON null), <en>)`. Before, the result of a `default` carried no key column, so its comparison scanned 100,000 rows. Now a `default` keeps the key column of the read it falls back from, marked as holding the value only on the rows where it is set. Wherever `fr` is present the result is `fr`, and the key column is NULL on every other row. A comparison through such a key column adds the bound `(key = LEFT(CONCAT('2', v), w) OR key IS NULL)` before the exact test of the value. MySQL serves it as `ref_or_null` on `internalTitleFr`, reading 1 row: 0.36 ms on 8.4 and on 9.7, against 137 ms before. This holds for every comparison operator and for chained defaults, and the answer is the one the value test alone gives.

### 2. `joinInner` joins the table itself (24× to 41× → 1.0× to 1.6×, and 0.8 ms indexed)

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

In the run, the three unindexed joins fell from 1045, 1608 and 2745 ms to 66, 83 and 127 ms on 8.4, and the indexed ones from 1120 to 2810 ms to 0.75 to 0.78 ms. They are bound by one scan of the instance that evaluates the JSON read on every row, the cost of the matching unindexed filter (56, 71 and 115 ms) plus the hash join; section 3 covers it.

### 3. Unindexed scans: one JSON path, still read twice (heading filter 79 → 71 ms)

A nested read such as `key("_internal").key("data").key("title").key("fr")` used to compile to four chained `JSON_EXTRACT` calls. Each call built the intermediate subdocument before the next one read it. Now a JSON read carries its document and path, so one more key extends the path, and the whole read is one `JSON_EXTRACT(_extra, '$."_internal"."data"."title"."fr"')`. The key columns' generation expression reads the same way, so the compiler and the index read one spelling.

The type-guarded string read, `CASE WHEN JSON_TYPE(<read>) … THEN CAST(JSON_UNQUOTE(<read>)) END`, still evaluates the read twice. MySQL has no function that reads a JSON string, and NULL for every other kind, from one evaluation. Dropping the type test would let `eq("7")` match a stored number 7, which the contract forbids. Measured on scratch 8.4:

| `_internal.data.title.fr = v` on 100,000 rows                  |   median |
| -------------------------------------------------------------- | -------: |
| module before: four chained reads, twice                       |  75.3 ms |
| module after: one path, twice                                  |  63.0 ms |
| one path, once, without the type test (not the contract)       |  45.3 ms |
| one path, once, typed through `REGEXP_SUBSTR` of its JSON text | 100.9 ms |

In the run, the heading filter fell from 79.2 to 71.0 ms (8.4) and from 80.4 to 71.3 ms (9.7), 2.2× postgres' 32.1 ms. `title.fr`, a one-key path, stays at 56 ms; one untyped read of it takes 41.9 ms (scratch), against postgres' 21 ms.

The decorators' unindexed filter takes 115 ms, 3.6× postgres. Its string read evaluates the whole fallback twice. On scratch 8.4, one evaluation of `COALESCE(NULLIF(fr, null), en)` takes 60.7 ms and the module's read 106 ms.

Convergence keeps a key column generated with the chained read: its signature names what it holds, not how its expression is spelled. `src/test/key-upgrade.test.ts` checks it on both versions, over documents whose path runs through an array, a null, a scalar or a missing key.

### 4. Sorts after `map`: postgres sorts in parallel (decorators form 2.2×)

Postgres plans these as `Gather Merge` over three processes. With parallel query off it took 394 ms for `title.fr` (MySQL 204 ms) and 137 ms for the decorators' read (MySQL then 139 ms, now 132 ms). MySQL has no parallel sort, and no index can serve an `orderBy` after `map` on either server.

### 5. Wrong answers

- `orderBy("title.fr")` on a table that declares no index used to sort by the literal top-level key `title.fr`, so every row tied. MySQL now reads an undeclared dotted name as a nested path, the rule index fields and `lookup`'s other key already used: an exact declared name first, otherwise a path below its first segment. It sorts the 100,000 books correctly in 119 ms (8.4), and `orderBy("_internal.data.title.fr")` in 110 ms. `getAll`, `between` and `group` take names through the same function and follow the same rule.
- Postgres still answers every `path` form wrong: its indexes, `orderBy` and `lookup` read a dotted name as one literal `_extra` key, so its `lookup` finds no book. This is the documented difference, and the ratios use postgres' correct forms.

### 6. Unindexed `lookup` (8.5× to 12×)

Without an index, MySQL's `lookup` is a correlated `LIMIT 1` subquery per review that scans until it finds the book. That costs 533 ms for 20 reviews by `title.fr`, about half a scan each, and 673 ms by the `_internal` path (756 before). The slow log's `rows_examined` (40) leaves out rows read inside correlated subqueries. Postgres' only correct answer is the `joinInner` hash join (44 ms). With the declared index the lookup takes 0.70 to 0.74 ms. A `lookup` that hash joins and keeps the first match per review would close the gap; not measured.

### 7. A value key under `internalTitleFr`

It now keys `_internal.data.title.fr` with a [value key](../docs/indexes.md#key-columns): a string's bound is `key = LEFT(CONCAT('2', v), 638)`, still one `ref`. Its rows' medians stay below the previous run's p95, as `titleFr`'s do with an unchanged key.

### 8. MariaDB reads text: an unindexed filter costs 5× to 18× postgres

The ANT-2022 threshold is index use wherever postgres uses one, and a median within 2× of postgres. MariaDB meets the first on both versions (section 11) and misses the second on 15 of 26 cells. Every unindexed filter misses it: 5.1× (`title.fr`), 9.0× to 9.4× (`_internal` path) and 17× to 18× (decorators), on 11.8 and 12.3.

MariaDB stores JSON as text, and `JSON_EXTRACT` costs more the larger the document, even for a key at its front. MySQL's binary JSON finds a key without reading the rest of the document. Scratch, one read of `$.title.fr` per row over 100,000 rows, the cost of one read taken as the slope between 2 and 16 reads per row:

| document, key at its front | MariaDB 11.8 | MariaDB 12.3 | MySQL 8.4 |
| -------------------------- | -----------: | -----------: | --------: |
| 43 bytes                   |      25.7 ms |      26.7 ms |   10.7 ms |
| 443 bytes                  |      88.7 ms |      88.1 ms |   11.2 ms |
| 1,743 bytes                |       284 ms |       285 ms |   11.1 ms |
| 6,843 bytes                |     1,070 ms |     1,052 ms |   11.1 ms |

The books' `_extra` is 430 bytes and `title` 44. One read of `_extra` costs 117 ms on 11.8 and 109 ms on 12.3, against 16 ms on MySQL 8.4; one read of `title` costs 24 and 22 ms, against 9 ms. The mechanism, that every call reads the whole text, is inferred from this scaling; the scaling itself is measured.

The module's typed string read evaluates its read twice, and the decorators' read four times (`fr` and `en`, each twice). Scratch, 100,000 rows, a scan with no JSON read takes 11 ms on all three:

| filter on equality, unindexed                  | MariaDB 11.8 | MariaDB 12.3 | MySQL 8.4 |
| ---------------------------------------------- | -----------: | -----------: | --------: |
| `title.fr`, module's read (twice)              |      98.8 ms |      93.2 ms |   47.0 ms |
| `title.fr`, one untyped read                   |      61.3 ms |      59.3 ms |   34.6 ms |
| `_internal` path, module's read (twice)        |       293 ms |       267 ms |   62.0 ms |
| `_internal` path, one untyped read             |       158 ms |       149 ms |   41.8 ms |
| decorators, module's read (four reads)         |       552 ms |       529 ms |    105 ms |
| decorators, one untyped `COALESCE` (two reads) |       289 ms |       274 ms |   63.6 ms |

Evaluating the read twice is half of the gap, and the contract forbids removing it (section 3). The other half is the cost of one read: a single untyped read of `_internal` is 149 to 158 ms, 4.6× to 4.9× postgres' 32.1 ms, and a single read of `title.fr` is 59 to 61 ms, 2.8× to 2.9× postgres' 21.3 ms. No spelling of the same comparison reaches 2× on a table with no key column. With a declared index there is a key column, and the filter reads one row (section 11).

### 9. MariaDB joins by block nested loop: unindexed `joinInner` 34× to 136×, `lookup` 24× to 37×

With the default `join_cache_level` of 2, MariaDB plans the unindexed `joinInner` as `Using join buffer (flat, BNL join)`: the 20 reviews sit in the join buffer, and the books are scanned once, 100,000 `r_rows`. For each book the condition is evaluated against every buffered review, so the typed read of the book runs 2,000,000 times, not 100,000. Scratch, 20 reviews, every statement answering the 20 expected rows:

| join of 20 reviews to 100,000 books, unindexed                  |       MariaDB 11.8 |       MariaDB 12.3 | MySQL 8.4 |
| --------------------------------------------------------------- | -----------------: | -----------------: | --------: |
| `_internal` path, module's shape                                |            5208 ms |            5053 ms |     82 ms |
| `_internal` path, 20 × the matching filter (293 ms, 267 ms)     |            5860 ms |            5340 ms |         – |
| decorators, module's shape                                      |           10363 ms |           10086 ms |    123 ms |
| decorators, 20 × the matching filter (552 ms, 529 ms)           |           11040 ms |           10580 ms |         – |
| `_internal` path, one untyped read                              |            2646 ms |            2502 ms |     59 ms |
| `_internal` path, `join_cache_level` 3 / 4 / 8                  | 5192 / 5266 / 5343 | 4905 / 4889 / 4934 |         – |
| `_internal` path, key computed once per book in a derived table |             465 ms |             427 ms |     89 ms |
| decorators, key computed once per book in a derived table       |             736 ms |             702 ms |    165 ms |

The join takes 89% to 95% of 20 times the filter, so the repeated evaluation explains it. The hashed join caches (levels 3 and 4) and the keyed one (level 8) change the time by less than 3%. The equality is on an expression of the scanned table, not on a column, which I take to be why none can key on it; the plans at those levels were not read. MySQL's 82 ms is the 62 ms filter plus 20 ms, which fits one evaluation per book.

Computing the key once per book, in a derived table that is not merged into the join (`optimizer_switch = 'derived_merge=off'`, set on the session; a statement-level spelling was not tested), takes the join from 5.1 s to 0.43 to 0.47 s, 11× to 12× faster. It stays at 5.4× to 5.9× postgres' 79.2 ms, and the decorators at 7.8× to 8.2× of 90.0 ms, because that one evaluation still pays section 8's cost per read. The two causes stack, and removing the join's does not reach 2×.

The unindexed `lookup` by path does not join: its plan is the same correlated subquery as MySQL's, scanning 47,492 and 47,435 `r_rows` per review (about half the books). MariaDB takes 1068 and 2903 ms on 11.8, 2.0× and 4.3× MySQL's 533 and 673 ms; section 8's per-read ratios are 2.5× for `title` and 7× for `_extra`. That fits the same cause; no scratch variant isolates it.

### 10. MariaDB sorts: the ranked key reads the document many times

An `orderBy` on a nested read of unknown type sorts by a ranked key, a type tag and then the value, written as a `CASE` chain. Its text names the read 15 times; how many the server evaluates per row depends on the branch and was not counted. `orderBy("_internal.data.title.fr")` misses at 12× and the `map` sorts at 2.6× to 32×. Scratch, 100,000 rows, the first 20 returned:

| heading read                                        | MariaDB 11.8 | MariaDB 12.3 | MySQL 8.4 |
| --------------------------------------------------- | -----------: | -----------: | --------: |
| `map` and `orderBy`, module's statement             |      1013 ms |       970 ms |    107 ms |
| the derived table alone (objects built, not sorted) |       193 ms |       180 ms |     94 ms |
| module's derived table, `ORDER BY` one typed read   |       440 ms |       417 ms |    172 ms |
| `orderBy(path)`, module's statement                 |       717 ms |       656 ms |    113 ms |
| same, `ORDER BY` one typed read                     |       316 ms |       294 ms |    137 ms |

The ranked key costs MariaDB 360 to 570 ms more than a single typed read, and MySQL nothing measurable. Postgres' parallel sort (section 4) is part of the ratio for the `map` forms, and no index serves an `orderBy` after `map` on any server. The decorators' `map` sort (31× to 32×) was not taken apart: its derived table adds the fallback's second read, and it takes 1.7× to 1.8× the heading form, as the decorators filter takes 1.9× the heading filter. The `title` `map` sort (2.6× to 2.8×) sorts by one typed read; MariaDB takes 2.0× MySQL's time there, and no scratch variant isolates it. `orderBy("title.fr")` on the unindexed table passes at 0.8×: one read of a 44-byte document.

### 11. MariaDB and the declared indexes

The module names its key columns itself, since MariaDB never matches an expression to a generated column: the statements read `__k_title_fr_…` and `__k__internal_data_title_fr_…`. Every cell with a declared index uses it on both versions, with the access types MySQL gets: `ref` on `titleFr` and `internalTitleFr` for filters, `joinInner` and `lookup`, `ref_or_null` for the decorators' read, `range` for `orderBy("<index>")`. They read 1 to 60 rows by `rows_examined`, take 0.4 to 1.6 ms, and no cell a declared index serves is over 0.03× postgres. The `map` sorts leave a declared index unused on MariaDB as on MySQL and postgres. No MariaDB cell has a wrong answer or an error in any of the 5 rounds.

Repeatability: a first full run, at a load average of 3.9 to 48.4, agreed with the one reported (2.3 to 11.7) within 10% on MariaDB 11.8's unindexed cells and 4% on 12.3's; the sub-millisecond declared cells moved up to 33%. Postgres' unindexed cells moved up to 22% between the two runs, which is the spread the 2× ratios carry. A slow cell stops early: the unindexed decorators `joinInner` ran 5 timed runs per round, at about 11 s each.
