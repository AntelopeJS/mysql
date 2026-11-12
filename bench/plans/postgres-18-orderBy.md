# pg 18: orderBy, then slice(0, 20)

The statements the module sent, from the server's own log, and their plans. Back to [RESULTS.md](../RESULTS.md).

<details><summary><code>orderBy:title:path:bare</code>: declared index not used</summary>

```sql
SELECT "t0"."_id", "t0"."_instance", "t0"."category", "t0"."title", "t0"."_extra" FROM "nested-bench"."books_bare" AS "t0" WHERE ("t0"."_instance" = ($1::text)) ORDER BY ("t0"."_extra" -> 'title.fr') ASC LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)
-- $1 = 'bench', $2 = '0', $3 = '20'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Limit (actual rows=20 loops=1)
  -> Gather Merge (actual rows=20 loops=1)
    -> Sort (actual rows=20 loops=3)
      Sort Key: ((_extra -> 'title.fr'::text))
      Sort Method: top-N heapsort
      -> Seq Scan on books_bare (actual rows=33333.33 loops=3)
        Filter: (_instance = 'bench'::text)
        Rows Removed by Filter: 0
```

</details>
<details><summary><code>orderBy:title:path:indexed</code>: declared index titleFr</summary>

```sql
SELECT "t0"."_id", "t0"."_instance", "t0"."category", "t0"."title", "t0"."_extra" FROM "nested-bench"."books_indexed" AS "t0" WHERE ("t0"."_instance" = ($1::text)) ORDER BY ("t0"."_extra" -> 'title.fr') ASC LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)
-- $1 = 'bench', $2 = '0', $3 = '20'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Limit (actual rows=20 loops=1)
  -> Index Scan using books_indexed_titleFr on books_indexed (actual rows=20 loops=1)
    Index Cond: (_instance = 'bench'::text)
```

</details>
<details><summary><code>orderBy:title:keys:bare</code>: declared index not used</summary>

```sql
SELECT "t1"."value" AS "value" FROM (SELECT jsonb_build_object('_id', to_jsonb("t0"."_id"), 'sortKey', to_jsonb((CASE WHEN jsonb_typeof(("t0"."title" -> 'fr')) = 'string' THEN (("t0"."title" -> 'fr') #>> '{}') END))) AS "value" FROM "nested-bench"."books_bare" AS "t0" WHERE ("t0"."_instance" = ($1::text))) AS "t1" ORDER BY (CASE WHEN jsonb_typeof(("t1"."value" -> 'sortKey')) = 'string' THEN (("t1"."value" -> 'sortKey') #>> '{}') END) ASC LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)
-- $1 = 'bench', $2 = '0', $3 = '20'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Limit (actual rows=20 loops=1)
  -> Gather Merge (actual rows=20 loops=1)
    -> Sort (actual rows=16 loops=3)
      Sort Key: (CASE WHEN (jsonb_typeof((jsonb_build_object('_id', to_jsonb(t0._id), 'sortKey', to_jsonb(CASE WHEN (jsonb_typeof((t0.title -> 'fr'::text)) = 's…
      Sort Method: top-N heapsort
      -> Seq Scan on books_bare (actual rows=33333.33 loops=3)
        Filter: (_instance = 'bench'::text)
        Rows Removed by Filter: 0
```

</details>
<details><summary><code>orderBy:title:keys:indexed</code>: declared index not used</summary>

```sql
SELECT "t1"."value" AS "value" FROM (SELECT jsonb_build_object('_id', to_jsonb("t0"."_id"), 'sortKey', to_jsonb((CASE WHEN jsonb_typeof(("t0"."title" -> 'fr')) = 'string' THEN (("t0"."title" -> 'fr') #>> '{}') END))) AS "value" FROM "nested-bench"."books_indexed" AS "t0" WHERE ("t0"."_instance" = ($1::text))) AS "t1" ORDER BY (CASE WHEN jsonb_typeof(("t1"."value" -> 'sortKey')) = 'string' THEN (("t1"."value" -> 'sortKey') #>> '{}') END) ASC LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)
-- $1 = 'bench', $2 = '0', $3 = '20'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Limit (actual rows=20 loops=1)
  -> Gather Merge (actual rows=20 loops=1)
    -> Sort (actual rows=17 loops=3)
      Sort Key: (CASE WHEN (jsonb_typeof((jsonb_build_object('_id', to_jsonb(t0._id), 'sortKey', to_jsonb(CASE WHEN (jsonb_typeof((t0.title -> 'fr'::text)) = 's…
      Sort Method: top-N heapsort
      -> Seq Scan on books_indexed (actual rows=33333.33 loops=3)
        Filter: (_instance = 'bench'::text)
        Rows Removed by Filter: 0
```

</details>
<details><summary><code>orderBy:heading:path:bare</code>: declared index not used</summary>

```sql
SELECT "t0"."_id", "t0"."_instance", "t0"."category", "t0"."title", "t0"."_extra" FROM "nested-bench"."books_bare" AS "t0" WHERE ("t0"."_instance" = ($1::text)) ORDER BY ("t0"."_extra" -> '_internal.data.title.fr') ASC LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)
-- $1 = 'bench', $2 = '0', $3 = '20'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Limit (actual rows=20 loops=1)
  -> Gather Merge (actual rows=20 loops=1)
    -> Sort (actual rows=20 loops=3)
      Sort Key: ((_extra -> '_internal.data.title.fr'::text))
      Sort Method: top-N heapsort
      -> Seq Scan on books_bare (actual rows=33333.33 loops=3)
        Filter: (_instance = 'bench'::text)
        Rows Removed by Filter: 0
```

</details>
<details><summary><code>orderBy:heading:path:indexed</code>: declared index internalTitleFr</summary>

```sql
SELECT "t0"."_id", "t0"."_instance", "t0"."category", "t0"."title", "t0"."_extra" FROM "nested-bench"."books_indexed" AS "t0" WHERE ("t0"."_instance" = ($1::text)) ORDER BY ("t0"."_extra" -> '_internal.data.title.fr') ASC LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)
-- $1 = 'bench', $2 = '0', $3 = '20'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Limit (actual rows=20 loops=1)
  -> Index Scan using books_indexed_internalTitleFr on books_indexed (actual rows=20 loops=1)
    Index Cond: (_instance = 'bench'::text)
```

</details>
<details><summary><code>orderBy:heading:keys:bare</code>: declared index not used</summary>

```sql
SELECT "t1"."value" AS "value" FROM (SELECT jsonb_build_object('_id', to_jsonb("t0"."_id"), 'sortKey', (((("t0"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr')) AS "value" FROM "nested-bench"."books_bare" AS "t0" WHERE ("t0"."_instance" = ($1::text))) AS "t1" ORDER BY ("t1"."value" -> 'sortKey') ASC LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)
-- $1 = 'bench', $2 = '0', $3 = '20'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Limit (actual rows=20 loops=1)
  -> Gather Merge (actual rows=20 loops=1)
    -> Sort (actual rows=16 loops=3)
      Sort Key: ((jsonb_build_object('_id', to_jsonb(t0._id), 'sortKey', ((((t0._extra -> '_internal'::text) -> 'data'::text) -> 'title'::text) -> 'fr'::text)) …
      Sort Method: top-N heapsort
      -> Seq Scan on books_bare (actual rows=33333.33 loops=3)
        Filter: (_instance = 'bench'::text)
        Rows Removed by Filter: 0
```

</details>
<details><summary><code>orderBy:heading:keys:indexed</code>: declared index not used</summary>

```sql
SELECT "t1"."value" AS "value" FROM (SELECT jsonb_build_object('_id', to_jsonb("t0"."_id"), 'sortKey', (((("t0"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr')) AS "value" FROM "nested-bench"."books_indexed" AS "t0" WHERE ("t0"."_instance" = ($1::text))) AS "t1" ORDER BY ("t1"."value" -> 'sortKey') ASC LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)
-- $1 = 'bench', $2 = '0', $3 = '20'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Limit (actual rows=20 loops=1)
  -> Gather Merge (actual rows=20 loops=1)
    -> Sort (actual rows=17 loops=3)
      Sort Key: ((jsonb_build_object('_id', to_jsonb(t0._id), 'sortKey', ((((t0._extra -> '_internal'::text) -> 'data'::text) -> 'title'::text) -> 'fr'::text)) …
      Sort Method: top-N heapsort
      -> Seq Scan on books_indexed (actual rows=33333.33 loops=3)
        Filter: (_instance = 'bench'::text)
        Rows Removed by Filter: 0
```

</details>
<details><summary><code>orderBy:heading:decorators:bare</code>: declared index not used</summary>

```sql
SELECT "t1"."value" AS "value" FROM (SELECT jsonb_build_object('_id', to_jsonb("t0"."_id"), 'sortKey', COALESCE(NULLIF((((("t0"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr'), 'null'::jsonb), (((("t0"."_extra" -> '_internal') -> 'data') -> 'title') -> 'en'))) AS "value" FROM "nested-bench"."books_bare" AS "t0" WHERE ("t0"."_instance" = ($1::text))) AS "t1" ORDER BY ("t1"."value" -> 'sortKey') ASC LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)
-- $1 = 'bench', $2 = '0', $3 = '20'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Limit (actual rows=20 loops=1)
  -> Gather Merge (actual rows=20 loops=1)
    -> Result (actual rows=16 loops=3)
      -> Sort (actual rows=16 loops=3)
        Sort Key: ((jsonb_build_object('_id', to_jsonb(t0._id), 'sortKey', COALESCE(NULLIF(((((t0._extra -> '_internal'::text) -> 'data'::text) -> 'title'::text…
        Sort Method: top-N heapsort
        -> Seq Scan on books_bare (actual rows=33333.33 loops=3)
          Filter: (_instance = 'bench'::text)
          Rows Removed by Filter: 0
```

</details>
<details><summary><code>orderBy:heading:decorators:indexed</code>: declared index not used</summary>

```sql
SELECT "t1"."value" AS "value" FROM (SELECT jsonb_build_object('_id', to_jsonb("t0"."_id"), 'sortKey', COALESCE(NULLIF((((("t0"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr'), 'null'::jsonb), (((("t0"."_extra" -> '_internal') -> 'data') -> 'title') -> 'en'))) AS "value" FROM "nested-bench"."books_indexed" AS "t0" WHERE ("t0"."_instance" = ($1::text))) AS "t1" ORDER BY ("t1"."value" -> 'sortKey') ASC LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)
-- $1 = 'bench', $2 = '0', $3 = '20'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Limit (actual rows=20 loops=1)
  -> Gather Merge (actual rows=20 loops=1)
    -> Result (actual rows=17 loops=3)
      -> Sort (actual rows=17 loops=3)
        Sort Key: ((jsonb_build_object('_id', to_jsonb(t0._id), 'sortKey', COALESCE(NULLIF(((((t0._extra -> '_internal'::text) -> 'data'::text) -> 'title'::text…
        Sort Method: top-N heapsort
        -> Seq Scan on books_indexed (actual rows=33333.33 loops=3)
          Filter: (_instance = 'bench'::text)
          Rows Removed by Filter: 0
```

</details>
