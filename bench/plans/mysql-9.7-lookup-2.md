# 9.7: Lookup from a 20-review page of the reviews table

The statements the module sent, from the server's own log, and their plans. Back to [RESULTS.md](../RESULTS.md).

<details><summary><code>lookup:heading:path:indexed</code>: declared index internalTitleFr</summary>

```sql
SELECT JSON_SET(JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t0`.`_instance`, '')) AS JSON), 'rating', CAST(`t0`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t0`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t0`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t0`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), '$."bookHeading"', `t2`.`value`) AS `value` FROM `nested-bench__reviews` AS `t0` LEFT JOIN LATERAL (SELECT JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t1`.`category`) AS JSON))), IF(`t1`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t1`.`title`)), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"')) AS `value` FROM `nested-bench__books_indexed` AS `t1` WHERE (`t1`.`_instance` = 'bench') AND (`t1`.`__k__internal_data_title_fr_cca329fe` = LEFT(`t0`.`bookHeading`, 640) AND (CASE WHEN (JSON_TYPE(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(`t1`.`_extra`, '$."_internal"'), '$."data"'), '$."title"'), '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(`t1`.`_extra`, '$."_internal"'), '$."data"'), '$."title"' …(1627 chars)
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | t0 | ref | PRIMARY | PRIMARY | 514 | 49775 | 100 | Rematerialize (<derived2>)
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 2 | 100 | Using where
2 | DEPENDENT DERIVED | t1 | ref | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 3077 | 1 | 100 | Using where

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=140630 rows=20) (actual time=0.0403..0.26 rows=20 loops=1)
    -> Nested loop left join  (cost=140630 rows=99550) (actual time=0.04..0.259 rows=20 loops=1)
        -> Invalidate materialized tables (row from t0)  (cost=4992 rows=49775) (actual time=0.00472..0.0145 rows=20 loops=1)
            -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4992 rows=49775) (actual time=0.00447..0.0134 rows=20 loops=1)
        -> Table scan on t2  (cost=2.53 rows=1) (actual time=0.0119..0.012 rows=1 loops=20)
            -> Materialize (invalidate on row from t0)  (cost=-1e+12 rows=1) (actual time=0.0118..0.0118 rows=1 loops=20)
                -> Limit: 1 row(s)  (cost=0.35 rows=1) (actual time=0.00746..0.00749 rows=1 loops=20)
                    -> Filter: ((t1.__k__internal_data_title_fr_cca329fe = left(t0.bookHeading,640)) and ((case when (json_type(json_extract(json_extract(json_e…
                        -> Index lookup on t1 using internalTitleFr (_instance = 'bench', __k__internal_data_title_fr_cca329fe = left(t0.bookHeading,640))  (cos…

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
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 49775 | 100 | NULL

EXPLAIN ANALYZE
-> Nested loop inner join  (cost=101528 rows=963300) (actual time=0.0289..1708 rows=20 loops=1)
    -> Table scan on t1  (cost=4997..4999 rows=20) (actual time=0.0215..0.0512 rows=20 loops=1)
        -> Materialize  (cost=4997..4997 rows=20) (actual time=0.0209..0.0209 rows=20 loops=1)
            -> Limit: 20 row(s)  (cost=4992 rows=20) (actual time=0.00347..0.0103 rows=20 loops=1)
                -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4992 rows=49775) (actual time=0.00328..0.00918 rows=20 loops=1)
    -> Filter: ((case when (json_type(json_extract(json_extract(json_extract(json_extract(t2._extra,'$."_internal"'),'$."data"'),'$."title"'),'$."fr"')) = <cach…
        -> Index lookup on t2 using PRIMARY (_instance = 'bench')  (cost=251 rows=48165) (actual time=0.00576..31 rows=100000 loops=20)

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
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 49775 | 100 | NULL

EXPLAIN ANALYZE
-> Nested loop inner join  (cost=101528 rows=963300) (actual time=0.0421..1785 rows=20 loops=1)
    -> Table scan on t1  (cost=4997..4999 rows=20) (actual time=0.0302..0.0684 rows=20 loops=1)
        -> Materialize  (cost=4997..4997 rows=20) (actual time=0.0294..0.0294 rows=20 loops=1)
            -> Limit: 20 row(s)  (cost=4992 rows=20) (actual time=0.0062..0.0142 rows=20 loops=1)
                -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4992 rows=49775) (actual time=0.00591..0.0129 rows=20 loops=1)
    -> Filter: ((case when (json_type(json_extract(json_extract(json_extract(json_extract(t2._extra,'$."_internal"'),'$."data"'),'$."title"'),'$."fr"')) = <cach…
        -> Index lookup on t2 using PRIMARY (_instance = 'bench')  (cost=251 rows=48165) (actual time=0.00787..34.4 rows=100000 loops=20)

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
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 49775 | 100 | NULL

EXPLAIN ANALYZE
-> Nested loop inner join  (cost=101528 rows=963300) (actual time=0.0418..2822 rows=20 loops=1)
    -> Table scan on t1  (cost=4997..4999 rows=20) (actual time=0.0285..0.0533 rows=20 loops=1)
        -> Materialize  (cost=4997..4997 rows=20) (actual time=0.0275..0.0275 rows=20 loops=1)
            -> Limit: 20 row(s)  (cost=4992 rows=20) (actual time=0.00539..0.0126 rows=20 loops=1)
                -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4992 rows=49775) (actual time=0.00505..0.0114 rows=20 loops=1)
    -> Filter: ((case when (json_type(coalesce(nullif(json_extract(json_extract(json_extract(json_extract(t2._extra,'$."_internal"'),'$."data"'),'$."title"'),'$…
        -> Index lookup on t2 using PRIMARY (_instance = 'bench')  (cost=251 rows=48165) (actual time=0.00501..31.5 rows=100000 loops=20)

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
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 49775 | 100 | NULL

EXPLAIN ANALYZE
-> Nested loop inner join  (cost=101528 rows=963300) (actual time=0.0437..2852 rows=20 loops=1)
    -> Table scan on t1  (cost=4997..4999 rows=20) (actual time=0.0289..0.0546 rows=20 loops=1)
        -> Materialize  (cost=4997..4997 rows=20) (actual time=0.0279..0.0279 rows=20 loops=1)
            -> Limit: 20 row(s)  (cost=4992 rows=20) (actual time=0.00529..0.0132 rows=20 loops=1)
                -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4992 rows=49775) (actual time=0.0051..0.0121 rows=20 loops=1)
    -> Filter: ((case when (json_type(coalesce(nullif(json_extract(json_extract(json_extract(json_extract(t2._extra,'$."_internal"'),'$."data"'),'$."title"'),'$…
        -> Index lookup on t2 using PRIMARY (_instance = 'bench')  (cost=251 rows=48165) (actual time=0.00531..33.4 rows=100000 loops=20)

```

</details>
