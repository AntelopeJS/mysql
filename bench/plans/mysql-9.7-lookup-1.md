# 9.7: Lookup from a 20-review page of the reviews table

The statements the module sent, from the server's own log, and their plans. Back to [RESULTS.md](../RESULTS.md).

<details><summary><code>lookup:title:path:bare</code>: declared index not used</summary>

```sql
SELECT JSON_SET(JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t0`.`_instance`, '')) AS JSON), 'rating', CAST(`t0`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t0`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t0`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t0`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), '$."bookTitle"', `t2`.`value`) AS `value` FROM `nested-bench__reviews` AS `t0` LEFT JOIN LATERAL (SELECT JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t1`.`category`) AS JSON))), IF(`t1`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t1`.`title`)), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"')) AS `value` FROM `nested-bench__books_bare` AS `t1` WHERE (`t1`.`_instance` = 'bench') AND ((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`title`, '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t1`.`title`, '$."fr"')) AS CHAR) END) = `t0`.`bookTitle`) LIMIT 1) AS `t2` ON TRUE WHERE (`t0`.`_instance` = 'bench') LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | t0 | ref | PRIMARY | PRIMARY | 514 | 49775 | 100 | Rematerialize (<derived2>)
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 2 | 100 | Using where
2 | DEPENDENT DERIVED | t1 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using where

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=145456 rows=20) (actual time=0.048..527 rows=20 loops=1)
    -> Nested loop left join  (cost=145456 rows=99550) (actual time=0.0475..527 rows=20 loops=1)
        -> Invalidate materialized tables (row from t0)  (cost=4992 rows=49775) (actual time=0.00765..0.0436 rows=20 loops=1)
            -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4992 rows=49775) (actual time=0.00735..0.0418 rows=20 loops=1)
        -> Table scan on t2  (cost=2.62 rows=1) (actual time=26.4..26.4 rows=1 loops=20)
            -> Materialize (invalidate on row from t0)  (cost=-1e+12 rows=1) (actual time=26.4..26.4 rows=1 loops=20)
                -> Limit: 1 row(s)  (cost=4826 rows=1) (actual time=26.3..26.3 rows=1 loops=20)
                    -> Filter: ((case when (json_type(json_extract(t1.title,'$."fr"')) = <cache>(('STRING' collate utf8mb4_bin))) then cast(json_unquote(json_ex…
                        -> Index lookup on t1 using PRIMARY (_instance = 'bench')  (cost=4826 rows=48165) (actual time=0.00364..14.3 rows=47492 loops=20)

```

</details>
<details><summary><code>lookup:title:path:indexed</code>: declared index titleFr</summary>

```sql
SELECT JSON_SET(JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t0`.`_instance`, '')) AS JSON), 'rating', CAST(`t0`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t0`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t0`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t0`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), '$."bookTitle"', `t2`.`value`) AS `value` FROM `nested-bench__reviews` AS `t0` LEFT JOIN LATERAL (SELECT JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t1`.`category`) AS JSON))), IF(`t1`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t1`.`title`)), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"')) AS `value` FROM `nested-bench__books_indexed` AS `t1` WHERE (`t1`.`_instance` = 'bench') AND (`t1`.`__k_title_fr_25b64d40` = LEFT(`t0`.`bookTitle`, 640) AND (CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`title`, '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t1`.`title`, '$."fr"')) AS CHAR) END) = `t0`.`bookTitle`) LIMIT 1) AS `t2` ON TRUE WHERE (`t0`.`_instance` = 'bench') LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | t0 | ref | PRIMARY | PRIMARY | 514 | 49775 | 100 | Rematerialize (<derived2>)
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 2 | 100 | Using where
2 | DEPENDENT DERIVED | t1 | ref | PRIMARY,titleFr,internalTitleFr | titleFr | 3077 | 1 | 100 | Using where

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=140630 rows=20) (actual time=0.0359..0.242 rows=20 loops=1)
    -> Nested loop left join  (cost=140630 rows=99550) (actual time=0.0355..0.24 rows=20 loops=1)
        -> Invalidate materialized tables (row from t0)  (cost=4992 rows=49775) (actual time=0.00495..0.0146 rows=20 loops=1)
            -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4992 rows=49775) (actual time=0.00481..0.0137 rows=20 loops=1)
        -> Table scan on t2  (cost=2.53 rows=1) (actual time=0.011..0.0111 rows=1 loops=20)
            -> Materialize (invalidate on row from t0)  (cost=-1e+12 rows=1) (actual time=0.0108..0.0108 rows=1 loops=20)
                -> Limit: 1 row(s)  (cost=0.35 rows=1) (actual time=0.00658..0.00661 rows=1 loops=20)
                    -> Filter: ((t1.__k_title_fr_25b64d40 = left(t0.bookTitle,640)) and ((case when (json_type(json_extract(t1.title,'$."fr"')) = <cache>(('STRI…
                        -> Index lookup on t1 using titleFr (_instance = 'bench', __k_title_fr_25b64d40 = left(t0.bookTitle,640))  (cost=0.35 rows=1) (actual ti…

```

</details>
<details><summary><code>lookup:title:keys:bare</code>: declared index not used</summary>

```sql
SELECT JSON_OBJECT('review', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'rating', CAST(`t1`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t1`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t1`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), 'book', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t3`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t3`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t3`.`category`) AS JSON))), IF(`t3`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t3`.`title`)), JSON_REMOVE(COALESCE(`t3`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"'))) AS `value` FROM (SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`rating`, `t0`.`bookTitle`, `t0`.`bookHeading`, `t0`.`_extra` FROM `nested-bench__reviews` AS `t0` WHERE (`t0`.`_instance` = 'bench') LIMIT 20 OFFSET 0) AS `t1` JOIN (SELECT `t2`.`_id`, `t2`.`_instance`, `t2`.`category`, `t2`.`title`, `t2`.`_extra` FROM `nested-bench__books_bare` AS `t2` WHERE (`t2`.`_instance` = 'bench')) AS `t3` ON (((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t3`.`title`, '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t3`.`title`, '$."fr"')) AS CHAR) END) = `t …(1516 chars)
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 20 | 100 | NULL
1 | PRIMARY | t2 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using where
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 49775 | 100 | NULL

EXPLAIN ANALYZE
-> Nested loop inner join  (cost=101528 rows=963300) (actual time=0.0282..1150 rows=20 loops=1)
    -> Table scan on t1  (cost=4997..4999 rows=20) (actual time=0.0222..0.0428 rows=20 loops=1)
        -> Materialize  (cost=4997..4997 rows=20) (actual time=0.0215..0.0215 rows=20 loops=1)
            -> Limit: 20 row(s)  (cost=4992 rows=20) (actual time=0.00342..0.0107 rows=20 loops=1)
                -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4992 rows=49775) (actual time=0.00322..0.00957 rows=20 loops=1)
    -> Filter: ((case when (json_type(json_extract(t2.title,'$."fr"')) = <cache>(('STRING' collate utf8mb4_bin))) then cast(json_unquote(json_extract(t2.title,'…
        -> Index lookup on t2 using PRIMARY (_instance = 'bench')  (cost=251 rows=48165) (actual time=0.00405..30.7 rows=100000 loops=20)

```

</details>
<details><summary><code>lookup:title:keys:indexed</code>: declared index not used</summary>

```sql
SELECT JSON_OBJECT('review', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'rating', CAST(`t1`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t1`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t1`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), 'book', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t3`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t3`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t3`.`category`) AS JSON))), IF(`t3`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t3`.`title`)), JSON_REMOVE(COALESCE(`t3`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"'))) AS `value` FROM (SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`rating`, `t0`.`bookTitle`, `t0`.`bookHeading`, `t0`.`_extra` FROM `nested-bench__reviews` AS `t0` WHERE (`t0`.`_instance` = 'bench') LIMIT 20 OFFSET 0) AS `t1` JOIN (SELECT `t2`.`_id`, `t2`.`_instance`, `t2`.`category`, `t2`.`title`, `t2`.`_extra` FROM `nested-bench__books_indexed` AS `t2` WHERE (`t2`.`_instance` = 'bench')) AS `t3` ON (((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t3`.`title`, '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t3`.`title`, '$."fr"')) AS CHAR) END) = …(1519 chars)
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 20 | 100 | NULL
1 | PRIMARY | t2 | ref | PRIMARY,titleFr,internalTitleFr | PRIMARY | 514 | 48165 | 100 | Using where
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 49775 | 100 | NULL

EXPLAIN ANALYZE
-> Nested loop inner join  (cost=101528 rows=963300) (actual time=0.0358..1179 rows=20 loops=1)
    -> Table scan on t1  (cost=4997..4999 rows=20) (actual time=0.0269..0.0435 rows=20 loops=1)
        -> Materialize  (cost=4997..4997 rows=20) (actual time=0.0259..0.0259 rows=20 loops=1)
            -> Limit: 20 row(s)  (cost=4992 rows=20) (actual time=0.00477..0.0117 rows=20 loops=1)
                -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4992 rows=49775) (actual time=0.00458..0.0106 rows=20 loops=1)
    -> Filter: ((case when (json_type(json_extract(t2.title,'$."fr"')) = <cache>(('STRING' collate utf8mb4_bin))) then cast(json_unquote(json_extract(t2.title,'…
        -> Index lookup on t2 using PRIMARY (_instance = 'bench')  (cost=251 rows=48165) (actual time=0.00379..32.2 rows=100000 loops=20)

```

</details>
<details><summary><code>lookup:heading:path:bare</code>: declared index not used</summary>

```sql
SELECT JSON_SET(JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t0`.`_instance`, '')) AS JSON), 'rating', CAST(`t0`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t0`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t0`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t0`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), '$."bookHeading"', `t2`.`value`) AS `value` FROM `nested-bench__reviews` AS `t0` LEFT JOIN LATERAL (SELECT JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t1`.`category`) AS JSON))), IF(`t1`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t1`.`title`)), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"')) AS `value` FROM `nested-bench__books_bare` AS `t1` WHERE (`t1`.`_instance` = 'bench') AND ((CASE WHEN (JSON_TYPE(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(`t1`.`_extra`, '$."_internal"'), '$."data"'), '$."title"'), '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(`t1`.`_extra`, '$."_internal"'), '$."data"'), '$."title"'), '$."fr"')) AS CHAR) END) = `t0`.`bookHeading`) LIMIT 1) AS `t2` ON TRUE WHERE (` …(1544 chars)
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | t0 | ref | PRIMARY | PRIMARY | 514 | 49775 | 100 | Rematerialize (<derived2>)
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 2 | 100 | Using where
2 | DEPENDENT DERIVED | t1 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using where

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=145456 rows=20) (actual time=0.035..785 rows=20 loops=1)
    -> Nested loop left join  (cost=145456 rows=99550) (actual time=0.0341..785 rows=20 loops=1)
        -> Invalidate materialized tables (row from t0)  (cost=4992 rows=49775) (actual time=0.00486..0.0308 rows=20 loops=1)
            -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4992 rows=49775) (actual time=0.00471..0.0297 rows=20 loops=1)
        -> Table scan on t2  (cost=2.62 rows=1) (actual time=39.2..39.2 rows=1 loops=20)
            -> Materialize (invalidate on row from t0)  (cost=-1e+12 rows=1) (actual time=39.2..39.2 rows=1 loops=20)
                -> Limit: 1 row(s)  (cost=4826 rows=1) (actual time=39.2..39.2 rows=1 loops=20)
                    -> Filter: ((case when (json_type(json_extract(json_extract(json_extract(json_extract(t1._extra,'$."_internal"'),'$."data"'),'$."title"'),'$…
                        -> Index lookup on t1 using PRIMARY (_instance = 'bench')  (cost=4826 rows=48165) (actual time=0.00233..14.2 rows=47434 loops=20)

```

</details>
