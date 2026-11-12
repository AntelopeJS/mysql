# pg 18: Filter on equality

The statements the module sent, from the server's own log, and their plans. Back to [RESULTS.md](../RESULTS.md).

<details><summary><code>filter:title:keys:bare</code>: declared index not used</summary>

```sql
SELECT "t0"."_id", "t0"."_instance", "t0"."category", "t0"."title", "t0"."_extra" FROM "nested-bench"."books_bare" AS "t0" WHERE ("t0"."_instance" = ($1::text)) AND (((CASE WHEN jsonb_typeof(("t0"."title" -> 'fr')) = 'string' THEN (("t0"."title" -> 'fr') #>> '{}') END) = ($2::text)))
-- $1 = 'bench', $2 = 'titre 067999'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Gather (actual rows=1 loops=1)
  -> Seq Scan on books_bare (actual rows=0.33 loops=3)
    Filter: ((_instance = 'bench'::text) AND (CASE WHEN (jsonb_typeof((title -> 'fr'::text)) = 'string'::text) THEN ((title -> 'fr'::text) #>> '{}'::text[]) ELS…
    Rows Removed by Filter: 33333
```

</details>
<details><summary><code>filter:title:keys:indexed</code>: declared index not used</summary>

```sql
SELECT "t0"."_id", "t0"."_instance", "t0"."category", "t0"."title", "t0"."_extra" FROM "nested-bench"."books_indexed" AS "t0" WHERE ("t0"."_instance" = ($1::text)) AND (((CASE WHEN jsonb_typeof(("t0"."title" -> 'fr')) = 'string' THEN (("t0"."title" -> 'fr') #>> '{}') END) = ($2::text)))
-- $1 = 'bench', $2 = 'titre 067999'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Gather (actual rows=1 loops=1)
  -> Seq Scan on books_indexed (actual rows=0.33 loops=3)
    Filter: ((_instance = 'bench'::text) AND (CASE WHEN (jsonb_typeof((title -> 'fr'::text)) = 'string'::text) THEN ((title -> 'fr'::text) #>> '{}'::text[]) ELS…
    Rows Removed by Filter: 33333
```

</details>
<details><summary><code>filter:heading:keys:bare</code>: declared index not used</summary>

```sql
SELECT "t0"."_id", "t0"."_instance", "t0"."category", "t0"."title", "t0"."_extra" FROM "nested-bench"."books_bare" AS "t0" WHERE ("t0"."_instance" = ($1::text)) AND (((CASE WHEN jsonb_typeof((((("t0"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr')) = 'string' THEN ((((("t0"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr') #>> '{}') END) = ($2::text)))
-- $1 = 'bench', $2 = 'intitulé 016147'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Gather (actual rows=1 loops=1)
  -> Seq Scan on books_bare (actual rows=0.33 loops=3)
    Filter: ((_instance = 'bench'::text) AND (CASE WHEN (jsonb_typeof(((((_extra -> '_internal'::text) -> 'data'::text) -> 'title'::text) -> 'fr'::text)) = 'str…
    Rows Removed by Filter: 33333
```

</details>
<details><summary><code>filter:heading:keys:indexed</code>: declared index not used</summary>

```sql
SELECT "t0"."_id", "t0"."_instance", "t0"."category", "t0"."title", "t0"."_extra" FROM "nested-bench"."books_indexed" AS "t0" WHERE ("t0"."_instance" = ($1::text)) AND (((CASE WHEN jsonb_typeof((((("t0"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr')) = 'string' THEN ((((("t0"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr') #>> '{}') END) = ($2::text)))
-- $1 = 'bench', $2 = 'intitulé 016147'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Gather (actual rows=1 loops=1)
  -> Seq Scan on books_indexed (actual rows=0.33 loops=3)
    Filter: ((_instance = 'bench'::text) AND (CASE WHEN (jsonb_typeof(((((_extra -> '_internal'::text) -> 'data'::text) -> 'title'::text) -> 'fr'::text)) = 'str…
    Rows Removed by Filter: 33333
```

</details>
<details><summary><code>filter:heading:decorators:bare</code>: declared index not used</summary>

```sql
SELECT "t0"."_id", "t0"."_instance", "t0"."category", "t0"."title", "t0"."_extra" FROM "nested-bench"."books_bare" AS "t0" WHERE ("t0"."_instance" = ($1::text)) AND (((CASE WHEN jsonb_typeof(COALESCE(NULLIF((((("t0"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr'), 'null'::jsonb), (((("t0"."_extra" -> '_internal') -> 'data') -> 'title') -> 'en'))) = 'string' THEN (COALESCE(NULLIF((((("t0"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr'), 'null'::jsonb), (((("t0"."_extra" -> '_internal') -> 'data') -> 'title') -> 'en')) #>> '{}') END) = ($2::text)))
-- $1 = 'bench', $2 = 'intitulé 016147'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Gather (actual rows=1 loops=1)
  -> Seq Scan on books_bare (actual rows=0.33 loops=3)
    Filter: ((_instance = 'bench'::text) AND (CASE WHEN (jsonb_typeof(COALESCE(NULLIF(((((_extra -> '_internal'::text) -> 'data'::text) -> 'title'::text) -> 'fr…
    Rows Removed by Filter: 33333
```

</details>
<details><summary><code>filter:heading:decorators:indexed</code>: declared index not used</summary>

```sql
SELECT "t0"."_id", "t0"."_instance", "t0"."category", "t0"."title", "t0"."_extra" FROM "nested-bench"."books_indexed" AS "t0" WHERE ("t0"."_instance" = ($1::text)) AND (((CASE WHEN jsonb_typeof(COALESCE(NULLIF((((("t0"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr'), 'null'::jsonb), (((("t0"."_extra" -> '_internal') -> 'data') -> 'title') -> 'en'))) = 'string' THEN (COALESCE(NULLIF((((("t0"."_extra" -> '_internal') -> 'data') -> 'title') -> 'fr'), 'null'::jsonb), (((("t0"."_extra" -> '_internal') -> 'data') -> 'title') -> 'en')) #>> '{}') END) = ($2::text)))
-- $1 = 'bench', $2 = 'intitulé 016147'
```

```text
EXPLAIN (ANALYZE, TIMING OFF) through auto_explain
Gather (actual rows=1 loops=1)
  -> Seq Scan on books_indexed (actual rows=0.33 loops=3)
    Filter: ((_instance = 'bench'::text) AND (CASE WHEN (jsonb_typeof(COALESCE(NULLIF(((((_extra -> '_internal'::text) -> 'data'::text) -> 'title'::text) -> 'fr…
    Rows Removed by Filter: 33333
```

</details>
