# 8.4: Lookup from a 20-review page of the reviews table

The statements the module sent, from the server's own log, and their plans. Back to [RESULTS.md](../RESULTS.md).

<details><summary><code>lookup:title:path:bare</code>: declared index not used</summary>

```sql
SELECT JSON_SET(JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t0`.`_instance`, '')) AS JSON), 'rating', CAST(`t0`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t0`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t0`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t0`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), '$."bookTitle"', `t2`.`value`) AS `value` FROM `nested-bench__reviews` AS `t0` LEFT JOIN LATERAL (SELECT JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t1`.`category`) AS JSON))), IF(`t1`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t1`.`title`)), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"')) AS `value` FROM `nested-bench__books_bare` AS `t1` WHERE (`t1`.`_instance` = 'bench') AND ((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`title`, '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t1`.`title`, '$."fr"')) AS CHAR) END) = `t0`.`bookTitle`) LIMIT 1) AS `t2` ON TRUE WHERE (`t0`.`_instance` = 'bench') LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | t0 | ref | PRIMARY | PRIMARY | 514 | 48523 | 100 | Rematerialize (<derived2>)
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 2 | 100 | Using where
2 | DEPENDENT DERIVED | t1 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using where

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=141918 rows=20) (actual time=0.126..879 rows=20 loops=1)
    -> Nested loop left join  (cost=141918 rows=97046) (actual time=0.125..879 rows=20 loops=1)
        -> Invalidate materialized tables (row from t0)  (cost=4867 rows=48523) (actual time=0.0254..0.125 rows=20 loops=1)
            -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4867 rows=48523) (actual time=0.025..0.123 rows=20 loops=1)
        -> Table scan on t2  (cost=2.62..2.62 rows=1) (actual time=43.9..43.9 rows=1 loops=20)
            -> Materialize (invalidate on row from t0)  (cost=4827..4827 rows=2) (actual time=43.9..43.9 rows=1 loops=20)
                -> Limit: 1 row(s)  (cost=4826 rows=1) (actual time=43.9..43.9 rows=1 loops=20)
                    -> Filter: ((case when (json_type(json_extract(t1.title,'$."fr"')) = <cache>(('STRING' collate utf8mb4_bin))) then cast(json_unquote(json_ex…
                        -> Index lookup on t1 using PRIMARY (_instance='bench')  (cost=4826 rows=48165) (actual time=0.0112..24.8 rows=47492 loops=20)

```

</details>
<details><summary><code>lookup:title:path:indexed</code>: declared index titleFr</summary>

```sql
SELECT JSON_SET(JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t0`.`_instance`, '')) AS JSON), 'rating', CAST(`t0`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t0`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t0`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t0`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), '$."bookTitle"', `t2`.`value`) AS `value` FROM `nested-bench__reviews` AS `t0` LEFT JOIN LATERAL (SELECT JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t1`.`category`) AS JSON))), IF(`t1`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t1`.`title`)), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"')) AS `value` FROM `nested-bench__books_indexed` AS `t1` WHERE (`t1`.`_instance` = 'bench') AND (`t1`.`__k_title_fr_25b64d40` = LEFT(`t0`.`bookTitle`, 640) AND (CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`title`, '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t1`.`title`, '$."fr"')) AS CHAR) END) = `t0`.`bookTitle`) LIMIT 1) AS `t2` ON TRUE WHERE (`t0`.`_instance` = 'bench') LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | t0 | ref | PRIMARY | PRIMARY | 514 | 48523 | 100 | Rematerialize (<derived2>)
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 2 | 100 | Using where
2 | DEPENDENT DERIVED | t1 | ref | PRIMARY,titleFr,internalTitleFr | titleFr | 3077 | 1 | 100 | Using where

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=137092 rows=20) (actual time=0.0675..0.481 rows=20 loops=1)
    -> Nested loop left join  (cost=137092 rows=97046) (actual time=0.0671..0.479 rows=20 loops=1)
        -> Invalidate materialized tables (row from t0)  (cost=4867 rows=48523) (actual time=0.0106..0.0362 rows=20 loops=1)
            -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4867 rows=48523) (actual time=0.0104..0.0349 rows=20 loops=1)
        -> Table scan on t2  (cost=2.53..2.53 rows=1) (actual time=0.0216..0.0217 rows=1 loops=20)
            -> Materialize (invalidate on row from t0)  (cost=0.55..0.55 rows=2) (actual time=0.0213..0.0213 rows=1 loops=20)
                -> Limit: 1 row(s)  (cost=0.35 rows=1) (actual time=0.0123..0.0123 rows=1 loops=20)
                    -> Filter: ((t1.__k_title_fr_25b64d40 = left(t0.bookTitle,640)) and ((case when (json_type(json_extract(t1.title,'$."fr"')) = <cache>(('STRI…
                        -> Index lookup on t1 using titleFr (_instance='bench', __k_title_fr_25b64d40=left(t0.bookTitle,640))  (cost=0.35 rows=1) (actual time=0…

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
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 48523 | 100 | NULL

EXPLAIN ANALYZE
-> Nested loop inner join  (cost=101400 rows=963300) (actual time=0.0559..1357 rows=20 loops=1)
    -> Table scan on t1  (cost=4869..4871 rows=20) (actual time=0.0411..0.0899 rows=20 loops=1)
        -> Materialize  (cost=4869..4869 rows=20) (actual time=0.0396..0.0396 rows=20 loops=1)
            -> Limit: 20 row(s)  (cost=4867 rows=20) (actual time=0.00969..0.0207 rows=20 loops=1)
                -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4867 rows=48523) (actual time=0.00897..0.0191 rows=20 loops=1)
    -> Filter: ((case when (json_type(json_extract(t2.title,'$."fr"')) = <cache>(('STRING' collate utf8mb4_bin))) then cast(json_unquote(json_extract(t2.title,'…
        -> Index lookup on t2 using PRIMARY (_instance='bench')  (cost=251 rows=48165) (actual time=0.00966..36.3 rows=100000 loops=20)

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
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 48523 | 100 | NULL

EXPLAIN ANALYZE
-> Nested loop inner join  (cost=101400 rows=963300) (actual time=0.0684..1459 rows=20 loops=1)
    -> Table scan on t1  (cost=4869..4871 rows=20) (actual time=0.0509..0.105 rows=20 loops=1)
        -> Materialize  (cost=4869..4869 rows=20) (actual time=0.0494..0.0494 rows=20 loops=1)
            -> Limit: 20 row(s)  (cost=4867 rows=20) (actual time=0.0122..0.0258 rows=20 loops=1)
                -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4867 rows=48523) (actual time=0.0116..0.0242 rows=20 loops=1)
    -> Filter: ((case when (json_type(json_extract(t2.title,'$."fr"')) = <cache>(('STRING' collate utf8mb4_bin))) then cast(json_unquote(json_extract(t2.title,'…
        -> Index lookup on t2 using PRIMARY (_instance='bench')  (cost=251 rows=48165) (actual time=0.0123..42.3 rows=100000 loops=20)

```

</details>
<details><summary><code>lookup:heading:path:bare</code>: declared index not used</summary>

```sql
SELECT JSON_SET(JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t0`.`_instance`, '')) AS JSON), 'rating', CAST(`t0`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t0`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t0`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t0`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), '$."bookHeading"', `t2`.`value`) AS `value` FROM `nested-bench__reviews` AS `t0` LEFT JOIN LATERAL (SELECT JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t1`.`category`) AS JSON))), IF(`t1`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t1`.`title`)), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"')) AS `value` FROM `nested-bench__books_bare` AS `t1` WHERE (`t1`.`_instance` = 'bench') AND ((CASE WHEN (JSON_TYPE(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(`t1`.`_extra`, '$."_internal"'), '$."data"'), '$."title"'), '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(`t1`.`_extra`, '$."_internal"'), '$."data"'), '$."title"'), '$."fr"')) AS CHAR) END) = `t0`.`bookHeading`) LIMIT 1) AS `t2` ON TRUE WHERE (` …(1544 chars)
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | t0 | ref | PRIMARY | PRIMARY | 514 | 48523 | 100 | Rematerialize (<derived2>)
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 2 | 100 | Using where
2 | DEPENDENT DERIVED | t1 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using where

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=141918 rows=20) (actual time=0.0384..928 rows=20 loops=1)
    -> Nested loop left join  (cost=141918 rows=97046) (actual time=0.0377..928 rows=20 loops=1)
        -> Invalidate materialized tables (row from t0)  (cost=4867 rows=48523) (actual time=0.00634..0.0746 rows=20 loops=1)
            -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4867 rows=48523) (actual time=0.00619..0.0732 rows=20 loops=1)
        -> Table scan on t2  (cost=2.62..2.62 rows=1) (actual time=46.4..46.4 rows=1 loops=20)
            -> Materialize (invalidate on row from t0)  (cost=4827..4827 rows=2) (actual time=46.4..46.4 rows=1 loops=20)
                -> Limit: 1 row(s)  (cost=4826 rows=1) (actual time=46.4..46.4 rows=1 loops=20)
                    -> Filter: ((case when (json_type(json_extract(json_extract(json_extract(json_extract(t1._extra,'$."_internal"'),'$."data"'),'$."title"'),'$…
                        -> Index lookup on t1 using PRIMARY (_instance='bench')  (cost=4826 rows=48165) (actual time=0.00847..17.1 rows=47434 loops=20)

```

</details>
