## Findings

Causes were measured on the same seeded servers after the run: the module's captured statements timed by hand against variants (median of 5 after 1 warm-up). The variants are diagnostics, not module output.

**Verdict.** Where MySQL's plan uses the declared index (`filter` by key chain, `orderBy("<index>")`, `lookup` by path), it answers in 0.3 to 0.8 ms, against 20 to 70 ms for postgres' best correct form. Wherever postgres uses an index, MySQL does too; postgres uses one only for `orderBy("<index>")`, where its answer is wrong. MySQL exceeds 2× on five shapes, each with a cause below. Two of them miss a declared index this module could use: the decorators' fallback and `joinInner`. Fixing the compiler is left to the lead.

### 1. The decorators' fallback defeats the key column (filter: 137 ms, declared index unused)

`unlockrequest` reads `fr` with `.default(en)`, which compiles to `COALESCE(NULLIF(<fr>, JSON null), <en>)`. `Compare` reaches a key column only through a plain path read (`PathReference`), so the comparison of a `default` names no key, and MySQL scans 100k rows (`rows_examined` 100000).

Proposed fix: when one operand of `=` is `x.default(y)` and `x` has a key reference, add the bound `(key(x) = LEFT(v, w) OR key(x) IS NULL)` in front of the current predicate, which stays as the exact recheck. A row whose `fr` is missing has a NULL key, so the bound keeps every row the fallback can match. Measured on `books_indexed`, 8.4 and 9.7 alike: 133.7 ms → **0.3 ms**, plan `ref_or_null` on `internalTitleFr`, 2 rows estimated, same answer.

### 2. `joinInner` is a nested loop over the whole instance (24× to 41×)

Every `joinInner` reads 2,000,020 rows (slow log), 100k per review, against 100,020 for postgres' hash join. The plan is `Index lookup on t2 using PRIMARY (_instance='bench')`, filtered once per review. The constant `_instance` equality on the primary key's prefix makes MySQL choose `ref` access, and `ref` access rules out its hash join. The right side is also a derived table that selects only the stored columns, so the condition cannot name a key column on `books_indexed`.

Measured on 8.4, hand-written joins over the same 20 reviews:

| join                                                                     |      median | plan                                                 |
| ------------------------------------------------------------------------ | ----------: | ---------------------------------------------------- |
| module, `lookup:title:keys:bare`                                         |     1044 ms | nested loop, 100000 rows × 20                        |
| optimizer hints `NO_INDEX(t2 PRIMARY) BNL(t2)` on the module's statement |     1048 ms | unchanged: `t2` sits inside the merged derived table |
| direct join, plain equality                                              |      764 ms | nested loop, `ref` on PRIMARY                        |
| same, `IGNORE INDEX (PRIMARY)` on books                                  | **41.7 ms** | inner hash join, one scan of 100000                  |
| direct join on the key column of `books_indexed`                         |  **0.3 ms** | `ref` on `titleFr`                                   |

Proposed fix: join a right side that is a bare table read directly, not as a derived table, so the predicate goes through `PathReference` and `Compare` and names the key column where a declared index has one. Where no key column serves the condition, mark the right table `IGNORE INDEX FOR JOIN (PRIMARY)` unless the condition reads `_id`, which lets MySQL hash join, as postgres does.

### 3. Unindexed scans: engine cost plus the predicate's shape (filter 2.5×, decorators filter 4.2×)

On `books_bare`, 8.4 (9.7 within 1 ms):

| statement                                              |   median |
| ------------------------------------------------------ | -------: |
| scan floor, `COUNT(*) WHERE _instance`                 |  12.5 ms |
| minimal `title->>'$.fr' = v`                           |  37.2 ms |
| module, `filter:title:keys:bare`                       |  50.3 ms |
| single path `_extra->>'$._internal.data.title.fr' = v` |  41.4 ms |
| four chained `JSON_EXTRACT` calls, once                |  48.6 ms |
| module, `filter:heading:keys:bare`                     |  78.1 ms |
| module, `filter:heading:decorators:bare`               | 130.8 ms |

Postgres takes 18 ms, 28 ms and 32 ms for the three module filters, and the same with parallel query off (18.2, 28.1, 32.3 ms with `max_parallel_workers_per_gather = 0`). So the engine alone is about 2× (37 against 18 ms). The module's `CASE WHEN JSON_TYPE(<read>) … THEN CAST(JSON_UNQUOTE(<read>)) END` evaluates the read twice and adds 13 ms on `title.fr`. On `_internal.*`, the read is four chained `JSON_EXTRACT` calls, each copying the subdocument, and it is evaluated twice, which adds 37 ms over one path. Proposed fix: compile a nested read as one JSON path (`'$."_internal"."data"."title"."fr"'`) and evaluate it once, which measures 41 ms here, 1.5× postgres. A declared index removes the scan entirely (0.33 ms).

### 4. Sorts after `map`: postgres sorts in parallel (decorators form 2.5×)

Postgres plans these as `Gather Merge` over three processes. With parallel query off, it takes 394 ms for `title.fr` (MySQL 204 ms) and 137 ms for the decorators' read (MySQL 139 ms). The gap is postgres' parallel query, which MySQL does not have for a sort. An index cannot serve an `orderBy` after `map` on either server.

### 5. Wrong answers

- `orderBy("title.fr")` on a table that declares no index sorts by the literal top-level key `title.fr` on both servers: MySQL emits `ORDER BY JSON_EXTRACT(_extra, '$."title.fr"')` and postgres `_extra -> 'title.fr'`. Every row ties, so the page is any 20 rows the sort leaves first (postgres `book-000001`…, MySQL `book-099965`…). MySQL reads the same dotted name as a nested path when an index declares it, and in `lookup`'s other key. Proposed fix: resolve an undeclared dotted name in `IndexColumns` the way `OtherKey` does.
- Postgres answers every `path` form wrong: its indexes, `orderBy` and `lookup` read a dotted name as a literal `_extra` key (`CREATE INDEX … ((_extra -> 'title.fr'))`), so its `lookup` finds no book. This is the documented difference; the ratios use postgres' correct forms.

### 6. Unindexed `lookup` (12×)

Without an index, MySQL's `lookup` is a correlated `LIMIT 1` subquery per review that scans until it finds the book: 478 ms server time for 20 reviews, about half a 50 ms scan each. The slow log's `rows_examined` (40) leaves out rows read inside correlated subqueries. Postgres' only correct answer is the `joinInner` hash join (40 ms). With the declared index the lookup takes 0.68 ms. A hash-joinable `lookup` (first match per review) would close the gap; not measured.
