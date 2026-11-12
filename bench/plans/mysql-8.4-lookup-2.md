# 8.4: Lookup from a 20-review page of the reviews table

The statements the module sent, from the server's own log, and their plans. Back to [RESULTS.md](../RESULTS.md).

<details><summary><code>lookup:heading:path:indexed</code>: declared index internalTitleFr</summary>

```sql
SELECT JSON_SET(JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t0`.`_instance`, '')) AS JSON), 'rating', CAST(`t0`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t0`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t0`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t0`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), '$."bookHeading"', `t2`.`value`) AS `value` FROM `nested-bench__reviews` AS `t0` LEFT JOIN LATERAL (SELECT JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t1`.`category`) AS JSON))), IF(`t1`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t1`.`title`)), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"')) AS `value` FROM `nested-bench__books_indexed` AS `t1` WHERE (`t1`.`_instance` = 'bench') AND (`t1`.`__k__internal_data_title_fr_cca329fe` = LEFT(`t0`.`bookHeading`, 640) AND (CASE WHEN (JSON_TYPE(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(`t1`.`_extra`, '$."_internal"'), '$."data"'), '$."title"'), '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(`t1`.`_extra`, '$."_internal"'), '$."data"'), '$."title"' …(1627 chars)
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | t0 | ref | PRIMARY | PRIMARY | 514 | 48523 | 100 | Rematerialize (<derived2>)
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 2 | 100 | Using where
2 | DEPENDENT DERIVED | t1 | ref | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 3077 | 1 | 100 | Using where

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=137092 rows=20) (actual time=0.0403..0.269 rows=20 loops=1)
    -> Nested loop left join  (cost=137092 rows=97046) (actual time=0.04..0.268 rows=20 loops=1)
        -> Invalidate materialized tables (row from t0)  (cost=4867 rows=48523) (actual time=0.00634..0.0162 rows=20 loops=1)
            -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4867 rows=48523) (actual time=0.00619..0.0152 rows=20 loops=1)
        -> Table scan on t2  (cost=2.53..2.53 rows=1) (actual time=0.0123..0.0124 rows=1 loops=20)
            -> Materialize (invalidate on row from t0)  (cost=0.55..0.55 rows=2) (actual time=0.0121..0.0121 rows=1 loops=20)
                -> Limit: 1 row(s)  (cost=0.35 rows=1) (actual time=0.00778..0.00781 rows=1 loops=20)
                    -> Filter: ((t1.__k__internal_data_title_fr_cca329fe = left(t0.bookHeading,640)) and ((case when (json_type(json_extract(json_extract(json_e…
                        -> Index lookup on t1 using internalTitleFr (_instance='bench', __k__internal_data_title_fr_cca329fe=left(t0.bookHeading,640))  (cost=0.…

```

</details>
<details><summary><code>lookup:heading:keys:bare</code>: declared index not used</summary>

```sql
SELECT JSON_OBJECT('review', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'rating', CAST(`t1`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t1`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t1`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), 'book', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t3`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t3`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t3`.`category`) AS JSON))), IF(`t3`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t3`.`title`)), JSON_REMOVE(COALESCE(`t3`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"'))) AS `value` FROM (SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`rating`, `t0`.`bookTitle`, `t0`.`bookHeading`, `t0`.`_extra` FROM `nested-bench__reviews` AS `t0` WHERE (`t0`.`_instance` = 'bench') LIMIT 20 OFFSET 0) AS `t1` JOIN (SELECT `t2`.`_id`, `t2`.`_instance`, `t2`.`category`, `t2`.`title`, `t2`.`_extra` FROM `nested-bench__books_bare` AS `t2` WHERE (`t2`.`_instance` = 'bench')) AS `t3` ON (((CASE WHEN (JSON_TYPE(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(`t3`.`_extra`, '$."_internal"'), '$."data"'), '$."title"'), '$."fr"')) IN ('STRING' COLLATE utf8mb4_ …(1688 chars)
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 20 | 100 | NULL
1 | PRIMARY | t2 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using where
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 48523 | 100 | NULL

EXPLAIN ANALYZE
-> Nested loop inner join  (cost=101400 rows=963300) (actual time=0.0304..2003 rows=20 loops=1)
    -> Table scan on t1  (cost=4869..4871 rows=20) (actual time=0.0219..0.0708 rows=20 loops=1)
        -> Materialize  (cost=4869..4869 rows=20) (actual time=0.0213..0.0213 rows=20 loops=1)
            -> Limit: 20 row(s)  (cost=4867 rows=20) (actual time=0.00366..0.0107 rows=20 loops=1)
                -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4867 rows=48523) (actual time=0.00348..0.00962 rows=20 loops=1)
    -> Filter: ((case when (json_type(json_extract(json_extract(json_extract(json_extract(t2._extra,'$."_internal"'),'$."data"'),'$."title"'),'$."fr"')) = <cach…
        -> Index lookup on t2 using PRIMARY (_instance='bench')  (cost=251 rows=48165) (actual time=0.00917..36.1 rows=100000 loops=20)

```

</details>
<details><summary><code>lookup:heading:keys:indexed</code>: declared index not used</summary>

```sql
SELECT JSON_OBJECT('review', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'rating', CAST(`t1`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t1`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t1`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), 'book', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t3`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t3`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t3`.`category`) AS JSON))), IF(`t3`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t3`.`title`)), JSON_REMOVE(COALESCE(`t3`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"'))) AS `value` FROM (SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`rating`, `t0`.`bookTitle`, `t0`.`bookHeading`, `t0`.`_extra` FROM `nested-bench__reviews` AS `t0` WHERE (`t0`.`_instance` = 'bench') LIMIT 20 OFFSET 0) AS `t1` JOIN (SELECT `t2`.`_id`, `t2`.`_instance`, `t2`.`category`, `t2`.`title`, `t2`.`_extra` FROM `nested-bench__books_indexed` AS `t2` WHERE (`t2`.`_instance` = 'bench')) AS `t3` ON (((CASE WHEN (JSON_TYPE(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(`t3`.`_extra`, '$."_internal"'), '$."data"'), '$."title"'), '$."fr"')) IN ('STRING' COLLATE utf8m …(1691 chars)
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 20 | 100 | NULL
1 | PRIMARY | t2 | ref | PRIMARY,titleFr,internalTitleFr | PRIMARY | 514 | 48165 | 100 | Using where
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 48523 | 100 | NULL

EXPLAIN ANALYZE
-> Nested loop inner join  (cost=101400 rows=963300) (actual time=0.0716..2026 rows=20 loops=1)
    -> Table scan on t1  (cost=4869..4871 rows=20) (actual time=0.0512..0.093 rows=20 loops=1)
        -> Materialize  (cost=4869..4869 rows=20) (actual time=0.0499..0.0499 rows=20 loops=1)
            -> Limit: 20 row(s)  (cost=4867 rows=20) (actual time=0.0125..0.0265 rows=20 loops=1)
                -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4867 rows=48523) (actual time=0.0118..0.0248 rows=20 loops=1)
    -> Filter: ((case when (json_type(json_extract(json_extract(json_extract(json_extract(t2._extra,'$."_internal"'),'$."data"'),'$."title"'),'$."fr"')) = <cach…
        -> Index lookup on t2 using PRIMARY (_instance='bench')  (cost=251 rows=48165) (actual time=0.00882..38.6 rows=100000 loops=20)

```

</details>
<details><summary><code>lookup:heading:decorators:bare</code>: declared index not used</summary>

```sql
SELECT JSON_OBJECT('review', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'rating', CAST(`t1`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t1`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t1`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), 'book', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t3`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t3`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t3`.`category`) AS JSON))), IF(`t3`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t3`.`title`)), JSON_REMOVE(COALESCE(`t3`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"'))) AS `value` FROM (SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`rating`, `t0`.`bookTitle`, `t0`.`bookHeading`, `t0`.`_extra` FROM `nested-bench__reviews` AS `t0` WHERE (`t0`.`_instance` = 'bench') LIMIT 20 OFFSET 0) AS `t1` JOIN (SELECT `t2`.`_id`, `t2`.`_instance`, `t2`.`category`, `t2`.`title`, `t2`.`_extra` FROM `nested-bench__books_bare` AS `t2` WHERE (`t2`.`_instance` = 'bench')) AS `t3` ON (((CASE WHEN (JSON_TYPE(COALESCE(NULLIF(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(`t3`.`_extra`, '$."_internal"'), '$."data"'), '$."title"'), '$."fr"'), CAST('null' A …(2014 chars)
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 20 | 100 | NULL
1 | PRIMARY | t2 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using where
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 48523 | 100 | NULL

EXPLAIN ANALYZE
-> Nested loop inner join  (cost=101400 rows=963300) (actual time=0.0509..2845 rows=20 loops=1)
    -> Table scan on t1  (cost=4869..4871 rows=20) (actual time=0.0354..0.0736 rows=20 loops=1)
        -> Materialize  (cost=4869..4869 rows=20) (actual time=0.0347..0.0347 rows=20 loops=1)
            -> Limit: 20 row(s)  (cost=4867 rows=20) (actual time=0.00538..0.0217 rows=20 loops=1)
                -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4867 rows=48523) (actual time=0.00502..0.0204 rows=20 loops=1)
    -> Filter: ((case when (json_type(coalesce(nullif(json_extract(json_extract(json_extract(json_extract(t2._extra,'$."_internal"'),'$."data"'),'$."title"'),'$…
        -> Index lookup on t2 using PRIMARY (_instance='bench')  (cost=251 rows=48165) (actual time=0.00717..31.7 rows=100000 loops=20)

```

</details>
<details><summary><code>lookup:heading:decorators:indexed</code>: declared index not used</summary>

```sql
SELECT JSON_OBJECT('review', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'rating', CAST(`t1`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t1`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t1`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), 'book', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t3`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t3`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t3`.`category`) AS JSON))), IF(`t3`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t3`.`title`)), JSON_REMOVE(COALESCE(`t3`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"'))) AS `value` FROM (SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`rating`, `t0`.`bookTitle`, `t0`.`bookHeading`, `t0`.`_extra` FROM `nested-bench__reviews` AS `t0` WHERE (`t0`.`_instance` = 'bench') LIMIT 20 OFFSET 0) AS `t1` JOIN (SELECT `t2`.`_id`, `t2`.`_instance`, `t2`.`category`, `t2`.`title`, `t2`.`_extra` FROM `nested-bench__books_indexed` AS `t2` WHERE (`t2`.`_instance` = 'bench')) AS `t3` ON (((CASE WHEN (JSON_TYPE(COALESCE(NULLIF(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(`t3`.`_extra`, '$."_internal"'), '$."data"'), '$."title"'), '$."fr"'), CAST('null …(2017 chars)
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 20 | 100 | NULL
1 | PRIMARY | t2 | ref | PRIMARY,titleFr,internalTitleFr | PRIMARY | 514 | 48165 | 100 | Using where
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 48523 | 100 | NULL

EXPLAIN ANALYZE
-> Nested loop inner join  (cost=101400 rows=963300) (actual time=0.0389..2900 rows=20 loops=1)
    -> Table scan on t1  (cost=4869..4871 rows=20) (actual time=0.0259..0.0663 rows=20 loops=1)
        -> Materialize  (cost=4869..4869 rows=20) (actual time=0.0253..0.0253 rows=20 loops=1)
            -> Limit: 20 row(s)  (cost=4867 rows=20) (actual time=0.00578..0.0127 rows=20 loops=1)
                -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4867 rows=48523) (actual time=0.00543..0.0116 rows=20 loops=1)
    -> Filter: ((case when (json_type(coalesce(nullif(json_extract(json_extract(json_extract(json_extract(t2._extra,'$."_internal"'),'$."data"'),'$."title"'),'$…
        -> Index lookup on t2 using PRIMARY (_instance='bench')  (cost=251 rows=48165) (actual time=0.00782..34.1 rows=100000 loops=20)

```

</details>
