# pg 18: Lookup from a 20-review page of the reviews table

The statements the module sent, from the server's own log, and their plans. Back to [RESULTS.md](../RESULTS.md).

<details><summary><code>lookup:title:path:bare</code>: declared index not used</summary>

```sql
SELECT ((jsonb_strip_nulls(jsonb_build_object('_id', "t0"."_id", '_instance', NULLIF("t0"."_instance", ''), 'rating', "t0"."rating", 'bookTitle', "t0"."bookTitle", 'bookHeading', "t0"."bookHeading")) || COALESCE("t0"."_extra", '{}'::jsonb)) || jsonb_build_object('bookTitle', "t2"."value")) AS "value" FROM "nested-bench"."reviews" AS "t0" LEFT JOIN LATERAL (SELECT (jsonb_strip_nulls(jsonb_build_object('_id', "t1"."_id", '_instance', NULLIF("t1"."_instance", ''), 'category', "t1"."category")) || (CASE WHEN "t1"."title" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('title', "t1"."title") END) || COALESCE("t1"."_extra", '{}'::jsonb)) AS "value" FROM "nested-bench"."books_bare" AS "t1" WHERE ("t1"."_instance" = ($4::text)) AND ((CASE WHEN jsonb_typeof(("t1"."_extra" -> 'title.fr')) = 'string' THEN (("t1"."_extra" -> 'title.fr') #>> '{}') END) = "t0"."bookTitle") LIMIT ((1)::bigint)) AS "t2" ON true WHERE ("t0"."_instance" = ($1::text)) LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)
-- $1 = 'bench', $2 = '0', $3 = '20', $4 = 'bench'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Limit (actual rows=20 loops=1)
  -> Nested Loop (actual rows=20 loops=1)
    -> Seq Scan on reviews (actual rows=20 loops=1)
      Filter: (_instance = 'bench'::text)
      Rows Removed by Filter: 0
    -> Limit (actual rows=0 loops=20)
      -> Seq Scan on books_bare (actual rows=0 loops=20)
        Filter: ((_instance = 'bench'::text) AND (CASE WHEN (jsonb_typeof((_extra -> 'title.fr'::text)) = 'string'::text) THEN ((_extra -> 'title.fr'::text) #>>…
        Rows Removed by Filter: 100000
```

</details>
<details><summary><code>lookup:title:path:indexed</code>: declared index not used</summary>

```sql
SELECT ((jsonb_strip_nulls(jsonb_build_object('_id', "t0"."_id", '_instance', NULLIF("t0"."_instance", ''), 'rating', "t0"."rating", 'bookTitle', "t0"."bookTitle", 'bookHeading', "t0"."bookHeading")) || COALESCE("t0"."_extra", '{}'::jsonb)) || jsonb_build_object('bookTitle', "t2"."value")) AS "value" FROM "nested-bench"."reviews" AS "t0" LEFT JOIN LATERAL (SELECT (jsonb_strip_nulls(jsonb_build_object('_id', "t1"."_id", '_instance', NULLIF("t1"."_instance", ''), 'category', "t1"."category")) || (CASE WHEN "t1"."title" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('title', "t1"."title") END) || COALESCE("t1"."_extra", '{}'::jsonb)) AS "value" FROM "nested-bench"."books_indexed" AS "t1" WHERE ("t1"."_instance" = ($4::text)) AND ((CASE WHEN jsonb_typeof(("t1"."_extra" -> 'title.fr')) = 'string' THEN (("t1"."_extra" -> 'title.fr') #>> '{}') END) = "t0"."bookTitle") LIMIT ((1)::bigint)) AS "t2" ON true WHERE ("t0"."_instance" = ($1::text)) LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)
-- $1 = 'bench', $2 = '0', $3 = '20', $4 = 'bench'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Limit (actual rows=20 loops=1)
  -> Nested Loop (actual rows=20 loops=1)
    -> Seq Scan on reviews (actual rows=20 loops=1)
      Filter: (_instance = 'bench'::text)
      Rows Removed by Filter: 0
    -> Limit (actual rows=0 loops=20)
      -> Seq Scan on books_indexed (actual rows=0 loops=20)
        Filter: ((_instance = 'bench'::text) AND (CASE WHEN (jsonb_typeof((_extra -> 'title.fr'::text)) = 'string'::text) THEN ((_extra -> 'title.fr'::text) #>>…
        Rows Removed by Filter: 100000
```

</details>
<details><summary><code>lookup:title:keys:bare</code>: declared index not used</summary>

```sql
SELECT jsonb_build_object('review', (jsonb_strip_nulls(jsonb_build_object('_id', "t1"."_id", '_instance', NULLIF("t1"."_instance", ''), 'rating', "t1"."rating", 'bookTitle', "t1"."bookTitle", 'bookHeading', "t1"."bookHeading")) || COALESCE("t1"."_extra", '{}'::jsonb)), 'book', (jsonb_strip_nulls(jsonb_build_object('_id', "t3"."_id", '_instance', NULLIF("t3"."_instance", ''), 'category', "t3"."category")) || (CASE WHEN "t3"."title" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('title', "t3"."title") END) || COALESCE("t3"."_extra", '{}'::jsonb))) AS "value" FROM (SELECT "t0"."_id", "t0"."_instance", "t0"."rating", "t0"."bookTitle", "t0"."bookHeading", "t0"."_extra" FROM "nested-bench"."reviews" AS "t0" WHERE ("t0"."_instance" = ($1::text)) LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)) AS "t1" JOIN (SELECT "t2"."_id", "t2"."_instance", "t2"."category", "t2"."title", "t2"."_extra" FROM "nested-bench"."books_bare" AS "t2" WHERE ("t2"."_instance" = ($4::text))) AS "t3" ON (((CASE WHEN jsonb_typeof(("t3"."title" -> 'fr')) = 'string' THEN (("t3"."title" -> 'fr') #>> '{}') END) = "t1"."bookTitle"))
-- $1 = 'bench', $2 = '0', $3 = '20', $4 = 'bench'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Hash Join (actual rows=20 loops=1)
  Hash Cond: (CASE WHEN (jsonb_typeof((t2.title -> 'fr'::text)) = 'string'::text) THEN ((t2.title -> 'fr'::text) #>> '{}'::text[]) ELSE NULL::text END = t0."boo…
  -> Seq Scan on books_bare (actual rows=100000 loops=1)
    Filter: (_instance = 'bench'::text)
    Rows Removed by Filter: 0
  -> Hash (actual rows=20 loops=1)
    -> Limit (actual rows=20 loops=1)
      -> Seq Scan on reviews (actual rows=20 loops=1)
        Filter: (_instance = 'bench'::text)
        Rows Removed by Filter: 0
```

</details>
<details><summary><code>lookup:title:keys:indexed</code>: declared index not used</summary>

```sql
SELECT jsonb_build_object('review', (jsonb_strip_nulls(jsonb_build_object('_id', "t1"."_id", '_instance', NULLIF("t1"."_instance", ''), 'rating', "t1"."rating", 'bookTitle', "t1"."bookTitle", 'bookHeading', "t1"."bookHeading")) || COALESCE("t1"."_extra", '{}'::jsonb)), 'book', (jsonb_strip_nulls(jsonb_build_object('_id', "t3"."_id", '_instance', NULLIF("t3"."_instance", ''), 'category', "t3"."category")) || (CASE WHEN "t3"."title" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('title', "t3"."title") END) || COALESCE("t3"."_extra", '{}'::jsonb))) AS "value" FROM (SELECT "t0"."_id", "t0"."_instance", "t0"."rating", "t0"."bookTitle", "t0"."bookHeading", "t0"."_extra" FROM "nested-bench"."reviews" AS "t0" WHERE ("t0"."_instance" = ($1::text)) LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)) AS "t1" JOIN (SELECT "t2"."_id", "t2"."_instance", "t2"."category", "t2"."title", "t2"."_extra" FROM "nested-bench"."books_indexed" AS "t2" WHERE ("t2"."_instance" = ($4::text))) AS "t3" ON (((CASE WHEN jsonb_typeof(("t3"."title" -> 'fr')) = 'string' THEN (("t3"."title" -> 'fr') #>> '{}') END) = "t1"."bookTitle"))
-- $1 = 'bench', $2 = '0', $3 = '20', $4 = 'bench'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Hash Join (actual rows=20 loops=1)
  Hash Cond: (CASE WHEN (jsonb_typeof((t2.title -> 'fr'::text)) = 'string'::text) THEN ((t2.title -> 'fr'::text) #>> '{}'::text[]) ELSE NULL::text END = t0."boo…
  -> Seq Scan on books_indexed (actual rows=100000 loops=1)
    Filter: (_instance = 'bench'::text)
    Rows Removed by Filter: 0
  -> Hash (actual rows=20 loops=1)
    -> Limit (actual rows=20 loops=1)
      -> Seq Scan on reviews (actual rows=20 loops=1)
        Filter: (_instance = 'bench'::text)
        Rows Removed by Filter: 0
```

</details>
<details><summary><code>lookup:heading:path:bare</code>: declared index not used</summary>

```sql
SELECT ((jsonb_strip_nulls(jsonb_build_object('_id', "t0"."_id", '_instance', NULLIF("t0"."_instance", ''), 'rating', "t0"."rating", 'bookTitle', "t0"."bookTitle", 'bookHeading', "t0"."bookHeading")) || COALESCE("t0"."_extra", '{}'::jsonb)) || jsonb_build_object('bookHeading', "t2"."value")) AS "value" FROM "nested-bench"."reviews" AS "t0" LEFT JOIN LATERAL (SELECT (jsonb_strip_nulls(jsonb_build_object('_id', "t1"."_id", '_instance', NULLIF("t1"."_instance", ''), 'category', "t1"."category")) || (CASE WHEN "t1"."title" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('title', "t1"."title") END) || COALESCE("t1"."_extra", '{}'::jsonb)) AS "value" FROM "nested-bench"."books_bare" AS "t1" WHERE ("t1"."_instance" = ($4::text)) AND ((CASE WHEN jsonb_typeof(("t1"."_extra" -> '_internal.data.title.fr')) = 'string' THEN (("t1"."_extra" -> '_internal.data.title.fr') #>> '{}') END) = "t0"."bookHeading") LIMIT ((1)::bigint)) AS "t2" ON true WHERE ("t0"."_instance" = ($1::text)) LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)
-- $1 = 'bench', $2 = '0', $3 = '20', $4 = 'bench'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Limit (actual rows=20 loops=1)
  -> Nested Loop (actual rows=20 loops=1)
    -> Seq Scan on reviews (actual rows=20 loops=1)
      Filter: (_instance = 'bench'::text)
      Rows Removed by Filter: 0
    -> Limit (actual rows=0 loops=20)
      -> Seq Scan on books_bare (actual rows=0 loops=20)
        Filter: ((_instance = 'bench'::text) AND (CASE WHEN (jsonb_typeof((_extra -> '_internal.data.title.fr'::text)) = 'string'::text) THEN ((_extra -> '_inte…
        Rows Removed by Filter: 100000
```

</details>
<details><summary><code>lookup:heading:path:indexed</code>: declared index not used</summary>

```sql
SELECT ((jsonb_strip_nulls(jsonb_build_object('_id', "t0"."_id", '_instance', NULLIF("t0"."_instance", ''), 'rating', "t0"."rating", 'bookTitle', "t0"."bookTitle", 'bookHeading', "t0"."bookHeading")) || COALESCE("t0"."_extra", '{}'::jsonb)) || jsonb_build_object('bookHeading', "t2"."value")) AS "value" FROM "nested-bench"."reviews" AS "t0" LEFT JOIN LATERAL (SELECT (jsonb_strip_nulls(jsonb_build_object('_id', "t1"."_id", '_instance', NULLIF("t1"."_instance", ''), 'category', "t1"."category")) || (CASE WHEN "t1"."title" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('title', "t1"."title") END) || COALESCE("t1"."_extra", '{}'::jsonb)) AS "value" FROM "nested-bench"."books_indexed" AS "t1" WHERE ("t1"."_instance" = ($4::text)) AND ((CASE WHEN jsonb_typeof(("t1"."_extra" -> '_internal.data.title.fr')) = 'string' THEN (("t1"."_extra" -> '_internal.data.title.fr') #>> '{}') END) = "t0"."bookHeading") LIMIT ((1)::bigint)) AS "t2" ON true WHERE ("t0"."_instance" = ($1::text)) LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)
-- $1 = 'bench', $2 = '0', $3 = '20', $4 = 'bench'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Limit (actual rows=20 loops=1)
  -> Nested Loop (actual rows=20 loops=1)
    -> Seq Scan on reviews (actual rows=20 loops=1)
      Filter: (_instance = 'bench'::text)
      Rows Removed by Filter: 0
    -> Limit (actual rows=0 loops=20)
      -> Seq Scan on books_indexed (actual rows=0 loops=20)
        Filter: ((_instance = 'bench'::text) AND (CASE WHEN (jsonb_typeof((_extra -> '_internal.data.title.fr'::text)) = 'string'::text) THEN ((_extra -> '_inte…
        Rows Removed by Filter: 100000
```

</details>
<details><summary><code>lookup:heading:keys:bare</code>: declared index not used</summary>

```sql
SELECT jsonb_build_object('review', (jsonb_strip_nulls(jsonb_build_object('_id', "t1"."_id", '_instance', NULLIF("t1"."_instance", ''), 'rating', "t1"."rating", 'bookTitle', "t1"."bookTitle", 'bookHeading', "t1"."bookHeading")) || COALESCE("t1"."_extra", '{}'::jsonb)), 'book', (jsonb_strip_nulls(jsonb_build_object('_id', "t3"."_id", '_instance', NULLIF("t3"."_instance", ''), 'category', "t3"."category")) || (CASE WHEN "t3"."title" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('title', "t3"."title") END) || COALESCE("t3"."_extra", '{}'::jsonb))) AS "value" FROM (SELECT "t0"."_id", "t0"."_instance", "t0"."rating", "t0"."bookTitle", "t0"."bookHeading", "t0"."_extra" FROM "nested-bench"."reviews" AS "t0" WHERE ("t0"."_instance" = ($1::text)) LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)) AS "t1" JOIN (SELECT "t2"."_id", "t2"."_instance", "t2"."category", "t2"."title", "t2"."_extra" FROM "nested-bench"."books_bare" AS "t2" WHERE ("t2"."_instance" = ($4::text))) AS "t3" ON (((CASE WHEN jsonb_typeof((((("t3"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr')) = 'string' THEN ((((("t3"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr') #>> '{}') END) = "t1"."bookHeading"))
-- $1 = 'bench', $2 = '0', $3 = '20', $4 = 'bench'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Hash Join (actual rows=20 loops=1)
  Hash Cond: (CASE WHEN (jsonb_typeof(((((t2._extra -> '_internal'::text) -> 'data'::text) -> 'title'::text) -> 'fr'::text)) = 'string'::text) THEN (((((t2._ext…
  -> Seq Scan on books_bare (actual rows=100000 loops=1)
    Filter: (_instance = 'bench'::text)
    Rows Removed by Filter: 0
  -> Hash (actual rows=20 loops=1)
    -> Limit (actual rows=20 loops=1)
      -> Seq Scan on reviews (actual rows=20 loops=1)
        Filter: (_instance = 'bench'::text)
        Rows Removed by Filter: 0
```

</details>
<details><summary><code>lookup:heading:keys:indexed</code>: declared index not used</summary>

```sql
SELECT jsonb_build_object('review', (jsonb_strip_nulls(jsonb_build_object('_id', "t1"."_id", '_instance', NULLIF("t1"."_instance", ''), 'rating', "t1"."rating", 'bookTitle', "t1"."bookTitle", 'bookHeading', "t1"."bookHeading")) || COALESCE("t1"."_extra", '{}'::jsonb)), 'book', (jsonb_strip_nulls(jsonb_build_object('_id', "t3"."_id", '_instance', NULLIF("t3"."_instance", ''), 'category', "t3"."category")) || (CASE WHEN "t3"."title" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('title', "t3"."title") END) || COALESCE("t3"."_extra", '{}'::jsonb))) AS "value" FROM (SELECT "t0"."_id", "t0"."_instance", "t0"."rating", "t0"."bookTitle", "t0"."bookHeading", "t0"."_extra" FROM "nested-bench"."reviews" AS "t0" WHERE ("t0"."_instance" = ($1::text)) LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)) AS "t1" JOIN (SELECT "t2"."_id", "t2"."_instance", "t2"."category", "t2"."title", "t2"."_extra" FROM "nested-bench"."books_indexed" AS "t2" WHERE ("t2"."_instance" = ($4::text))) AS "t3" ON (((CASE WHEN jsonb_typeof((((("t3"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr')) = 'string' THEN ((((("t3"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr') #>> '{}') END) = "t1"."bookHeading"))
-- $1 = 'bench', $2 = '0', $3 = '20', $4 = 'bench'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Hash Join (actual rows=20 loops=1)
  Hash Cond: (CASE WHEN (jsonb_typeof(((((t2._extra -> '_internal'::text) -> 'data'::text) -> 'title'::text) -> 'fr'::text)) = 'string'::text) THEN (((((t2._ext…
  -> Seq Scan on books_indexed (actual rows=100000 loops=1)
    Filter: (_instance = 'bench'::text)
    Rows Removed by Filter: 0
  -> Hash (actual rows=20 loops=1)
    -> Limit (actual rows=20 loops=1)
      -> Seq Scan on reviews (actual rows=20 loops=1)
        Filter: (_instance = 'bench'::text)
        Rows Removed by Filter: 0
```

</details>
