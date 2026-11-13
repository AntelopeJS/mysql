## Findings

This run measures the module after section 3's change and its base, main at `bf99ec8`, in one window: each round ran both back to back on every MySQL-family server, at a load average of 2.85 to 8.90 ([plans/base-head.md](plans/base-head.md)). Sections 1, 2, 4 to 7 and 9 to 11 keep the numbers of the run of 2026-11-12 08:55 UTC; section 9 predates the join key MariaDB now computes once per row (#10), under which its unindexed joins took 6.8× to 12× postgres here. _Scratch_ numbers time hand-written variants, diagnostics and not module output: a 100,000-row table on containers of their own, seeded by SQL (MySQL, section 3) or through the module (MariaDB, sections 8 to 11); medians of 3 to 7 after a warm-up, or for section 3 the minimum of 15 interleaved rounds.

**Verdict.** A declared index serves every question it can on MySQL and MariaDB, in 0.4 to 1.6 ms. Without one, a filter comparing a JSON read with a string now tests the read's `JSON_VALUE` text first and reads the value's kind only where that text matches (section 3). In the same window as its base, the change takes MySQL's unindexed filters to 0.48× to 0.86× of the base's time and MariaDB's to 0.20× to 0.46×, and leaves every other case within 4% of it. Against postgres, MySQL meets 2× on the `_internal…` filter (1.76× to 1.82×) and the decorators' (1.80× to 1.82×), and misses it on `title.fr` (2.30× to 2.32×), whose floor is one JSON read: 2.0× by itself. MariaDB's unindexed filters run at 2.5× to 4.3× postgres, since one read of text JSON costs more than postgres' whole filter (section 8). Every MySQL and MariaDB answer is correct.

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

### 3. Unindexed scans: the text in one read, then the kind (heading filter 71 → 51 ms)

A nested read is one `JSON_EXTRACT` of the whole path, spelled as the key columns' generation expression is. Compared with a string, it is read as one: `CASE WHEN JSON_TYPE(<read>) … THEN CAST(JSON_UNQUOTE(<read>)) END` evaluates the read twice, the decorators' four times. No function reads a JSON string, and SQL NULL for any other kind, in one evaluation, and without the kind test `eq("7")` would match a stored 7, which the contract forbids.

A filter, a join's condition, an array's `filter` and `not()` read only a comparison's truth. Where no key column serves it, they now test `CAST(JSON_VALUE(<document>, <path>) AS CHAR) <op> v` first, which holds wherever the typed comparison does, and run the typed comparison only on the rows it keeps. MySQL spells it `RETURNING CHAR(4294967295)`, since the default `VARCHAR(512)` answers SQL NULL for a longer string. A comparison projected in a `map` keeps its exact SQL, so a value of another kind still projects as `null`.

A default's text is `COALESCE(<fr text>, <en text>)` on MySQL, where `JSON_VALUE` is SQL NULL exactly where the read is absent or a JSON null. MariaDB's `JSON_VALUE` finds a plain key stored escaped, as `"f\u0072"`, that its member read leaves unread, so it tests `(<fr text> = v OR <en text> = v)`, reading `en` wherever `fr` differs. A declared string member, such as `title.fr` here, keeps its texts through the cast that reads it as text.

Scratch at a load average of 10, 8.4 and 9.7, minimum of 15 rounds:

| `= v` on 100,000 rows                     |      8.4 |      9.7 |
| ----------------------------------------- | -------: | -------: |
| scan with no JSON read                    |  18.7 ms |  18.7 ms |
| `_internal` path, text then kind          |  50.9 ms |  51.1 ms |
| decorators, module before                 | 109.3 ms | 111.3 ms |
| decorators, one `COALESCE` text then kind |  51.7 ms |  52.6 ms |
| decorators, each text then kind (`OR`)    |  74.3 ms |  74.0 ms |

In the run, each against postgres and, in the same window, against the base:

| unindexed filter | postgres |     8.4: ÷ pg, ÷ base |     9.7: ÷ pg, ÷ base |
| ---------------- | -------: | --------------------: | --------------------: |
| `title.fr`       |  19.2 ms | 44.1 ms: 2.30×, 0.86× | 44.6 ms: 2.32×, 0.86× |
| `_internal…`     |  29.3 ms | 51.7 ms: 1.76×, 0.78× | 53.2 ms: 1.82×, 0.79× |
| decorators       |  33.7 ms | 52.7 ms: 1.80×, 0.48× | 53.3 ms: 1.82×, 0.49× |

A join's condition takes the text test only on MariaDB, which evaluates it once per pair of rows. MySQL hash joins on every equality of the condition, so the test was a second key read per book: 107 → 149 ms on scratch 8.4. Its joins now run at 0.97× to 1.03× of the base.

`title.fr` misses 2×. Its read is one `JSON_VALUE` of a 44-byte document, 25 to 30 ms over a scan with no JSON read on scratch, where postgres answers the whole filter in 19.2 ms; one untyped read, without the kind test the contract requires, took 41.9 ms on scratch 8.4 in the run before, 2.0× by itself.

`src/test/key-upgrade.test.ts` checks that convergence keeps a key column generated with the older chained read. `src/test/text-read.test.ts` checks that a filter keeps exactly the rows its projected comparison is true on, over strings, numbers, nulls, absent and escaped values, a key stored escaped and a declared string member holding a number.

### 4. Sorts after `map`: postgres sorts in parallel (decorators form 2.2×)

Postgres plans these as `Gather Merge` over three processes. With parallel query off it took 394 ms for `title.fr` (MySQL 204 ms) and 137 ms for the decorators' read (MySQL then 139 ms, now 132 ms). MySQL has no parallel sort, and no index can serve an `orderBy` after `map` on either server.

### 5. Wrong answers

- `orderBy("title.fr")` on a table that declares no index used to sort by the literal top-level key `title.fr`, so every row tied. MySQL now reads an undeclared dotted name as a nested path, the rule index fields and `lookup`'s other key already used: an exact declared name first, otherwise a path below its first segment. It sorts the 100,000 books correctly in 119 ms (8.4), and `orderBy("_internal.data.title.fr")` in 110 ms. `getAll`, `between` and `group` take names through the same function and follow the same rule.
- Postgres still answers every `path` form wrong: its indexes, `orderBy` and `lookup` read a dotted name as one literal `_extra` key, so its `lookup` finds no book. This is the documented difference, and the ratios use postgres' correct forms.

### 6. Unindexed `lookup` (8.5× to 12×)

Without an index, MySQL's `lookup` is a correlated `LIMIT 1` subquery per review that scans until it finds the book. That costs 533 ms for 20 reviews by `title.fr`, about half a scan each, and 673 ms by the `_internal` path (756 before). The slow log's `rows_examined` (40) leaves out rows read inside correlated subqueries. Postgres' only correct answer is the `joinInner` hash join (44 ms). With the declared index the lookup takes 0.70 to 0.74 ms. A `lookup` that hash joins and keeps the first match per review would close the gap; not measured.

### 7. A value key under `internalTitleFr`

It now keys `_internal.data.title.fr` with a [value key](../docs/indexes.md#key-columns): a string's bound is `key = LEFT(CONCAT('2', v), 638)`, still one `ref`. Its rows' medians stay below the previous run's p95, as `titleFr`'s do with an unchanged key.

### 8. MariaDB reads text: an unindexed filter costs 2.5× to 4.3× postgres

The ANT-2022 threshold is index use wherever postgres uses one, which MariaDB meets (section 11), and a median within 2× of postgres, which every unindexed filter misses.

MariaDB stores JSON as text, and `JSON_EXTRACT` costs more the larger the document, even for a key at its front. MySQL's binary JSON finds a key without reading the rest of the document. Scratch, one read of `$.title.fr` per row over 100,000 rows, the cost of one read taken as the slope between 2 and 16 reads per row:

| document, key at its front | MariaDB 11.8 | MariaDB 12.3 | MySQL 8.4 |
| -------------------------- | -----------: | -----------: | --------: |
| 43 bytes                   |      25.7 ms |      26.7 ms |   10.7 ms |
| 443 bytes                  |      88.7 ms |      88.1 ms |   11.2 ms |
| 1,743 bytes                |       284 ms |       285 ms |   11.1 ms |
| 6,843 bytes                |     1,070 ms |     1,052 ms |   11.1 ms |

The books' `_extra` is 430 bytes and `title` 44. One read of `_extra` costs 117 ms on 11.8 and 109 ms on 12.3, against 16 ms on MySQL 8.4; one read of `title` costs 24 and 22 ms, against 9 ms.

`JSON_VALUE` costs a fraction of a `JSON_EXTRACT` of the same path, as if it stopped at the member where `JSON_EXTRACT` reads every call's whole text; both mechanisms are inferred from timings. Scratch at a load average of 25 to 29, minimum of 15 interleaved rounds; a scan with no JSON read took 17 ms:

| `= v` on 100,000 rows, unindexed                | MariaDB 11.8 | MariaDB 12.3 |
| ----------------------------------------------- | -----------: | -----------: |
| `title.fr`, module before (two reads)           |     104.0 ms |     104.9 ms |
| `title.fr`, one `JSON_EXTRACT`, then the kind   |      68.5 ms |      67.5 ms |
| `title.fr`, `JSON_VALUE`, then the kind         |      42.6 ms |      46.3 ms |
| `_internal` path, module before                 |     295.1 ms |     279.4 ms |
| `_internal` path, one `JSON_EXTRACT`, then kind |     161.6 ms |     158.0 ms |
| `_internal` path, `JSON_VALUE`, then the kind   |      69.3 ms |      71.8 ms |
| decorators, module before (four reads)          |     559.0 ms |     536.9 ms |
| decorators, one `COALESCE` of texts, then kind  |      70.1 ms |      72.9 ms |

The module tests each of the decorators' texts on MariaDB (section 3): 123 and 113 ms against the `COALESCE`'s 79 and 68 ms on scratch at a load of 10. In the run, each against postgres and, in the same window, against the base:

| unindexed filter |    11.8: ÷ pg, ÷ base |    12.3: ÷ pg, ÷ base |
| ---------------- | --------------------: | --------------------: |
| `title.fr`       | 47.5 ms: 2.47×, 0.43× | 49.4 ms: 2.57×, 0.46× |
| `_internal…`     | 74.3 ms: 2.54×, 0.24× | 74.8 ms: 2.55×, 0.26× |
| decorators       |  125 ms: 4.27×, 0.20× |  121 ms: 4.15×, 0.21× |

The rest is the cost of the read itself: one `JSON_VALUE` of the `_internal` path costs 50 ms over the scan on scratch, against postgres' whole filter at 29.3 ms, and the decorators' read takes two of them on every row its `fr` does not match. With a declared index there is a key column, and the filter reads one row (section 11).

`JSON_VALUE` decodes a key stored escaped and `JSON_EXTRACT` does not. In an object that names one key twice, once escaped, as in `{"\u0061": "x", "a": "g"}`, `JSON_VALUE` reads `x` and the typed read `g`, so such a row is missing from the filter on `a = "g"`. The module never writes such a document; the case is in [`docs/mariadb.md`](../docs/mariadb.md).

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
