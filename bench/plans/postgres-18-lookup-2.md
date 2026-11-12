# pg 18: Lookup from a 20-review page of the reviews table

The statements the module sent, from the server's own log, and their plans. Back to [RESULTS.md](../RESULTS.md).

<details><summary><code>lookup:heading:decorators:bare</code>: declared index not used</summary>

```sql
SELECT jsonb_build_object('review', (jsonb_strip_nulls(jsonb_build_object('_id', "t1"."_id", '_instance', NULLIF("t1"."_instance", ''), 'rating', "t1"."rating", 'bookTitle', "t1"."bookTitle", 'bookHeading', "t1"."bookHeading")) || COALESCE("t1"."_extra", '{}'::jsonb)), 'book', (jsonb_strip_nulls(jsonb_build_object('_id', "t3"."_id", '_instance', NULLIF("t3"."_instance", ''), 'category', "t3"."category")) || (CASE WHEN "t3"."title" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('title', "t3"."title") END) || COALESCE("t3"."_extra", '{}'::jsonb))) AS "value" FROM (SELECT "t0"."_id", "t0"."_instance", "t0"."rating", "t0"."bookTitle", "t0"."bookHeading", "t0"."_extra" FROM "nested-bench"."reviews" AS "t0" WHERE ("t0"."_instance" = ($1::text)) LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)) AS "t1" JOIN (SELECT "t2"."_id", "t2"."_instance", "t2"."category", "t2"."title", "t2"."_extra" FROM "nested-bench"."books_bare" AS "t2" WHERE ("t2"."_instance" = ($4::text))) AS "t3" ON (((CASE WHEN jsonb_typeof(COALESCE(NULLIF((((("t3"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr'), 'null'::jsonb), (((("t3"."_extra" -> '_internal') -> 'data') -> 'title') -> 'en'))) = 'string' THEN (COALESCE(NULLIF((((("t3"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr'), …(1672 chars)
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Hash Join (actual rows=20 loops=1)
  Hash Cond: (CASE WHEN (jsonb_typeof(COALESCE(NULLIF(((((t2._extra -> '_internal'::text) -> 'data'::text) -> 'title'::text) -> 'fr'::text), 'null'::jsonb), (((…
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
<details><summary><code>lookup:heading:decorators:indexed</code>: declared index not used</summary>

```sql
SELECT jsonb_build_object('review', (jsonb_strip_nulls(jsonb_build_object('_id', "t1"."_id", '_instance', NULLIF("t1"."_instance", ''), 'rating', "t1"."rating", 'bookTitle', "t1"."bookTitle", 'bookHeading', "t1"."bookHeading")) || COALESCE("t1"."_extra", '{}'::jsonb)), 'book', (jsonb_strip_nulls(jsonb_build_object('_id', "t3"."_id", '_instance', NULLIF("t3"."_instance", ''), 'category', "t3"."category")) || (CASE WHEN "t3"."title" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('title', "t3"."title") END) || COALESCE("t3"."_extra", '{}'::jsonb))) AS "value" FROM (SELECT "t0"."_id", "t0"."_instance", "t0"."rating", "t0"."bookTitle", "t0"."bookHeading", "t0"."_extra" FROM "nested-bench"."reviews" AS "t0" WHERE ("t0"."_instance" = ($1::text)) LIMIT ((CASE WHEN ($3::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($3::double precision)), 0), 2147483647) END)::bigint) OFFSET ((CASE WHEN ($2::double precision) IS NOT NULL THEN LEAST(GREATEST(trunc(($2::double precision)), 0), 2147483647) END)::bigint)) AS "t1" JOIN (SELECT "t2"."_id", "t2"."_instance", "t2"."category", "t2"."title", "t2"."_extra" FROM "nested-bench"."books_indexed" AS "t2" WHERE ("t2"."_instance" = ($4::text))) AS "t3" ON (((CASE WHEN jsonb_typeof(COALESCE(NULLIF((((("t3"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr'), 'null'::jsonb), (((("t3"."_extra" -> '_internal') -> 'data') -> 'title') -> 'en'))) = 'string' THEN (COALESCE(NULLIF((((("t3"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr …(1675 chars)
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Hash Join (actual rows=20 loops=1)
  Hash Cond: (CASE WHEN (jsonb_typeof(COALESCE(NULLIF(((((t2._extra -> '_internal'::text) -> 'data'::text) -> 'title'::text) -> 'fr'::text), 'null'::jsonb), (((…
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
