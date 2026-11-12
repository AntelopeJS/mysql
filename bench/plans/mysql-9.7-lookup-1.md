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
-> Limit: 20 row(s)  (cost=145456 rows=20) (actual time=0.0734..629 rows=20 loops=1)
    -> Nested loop left join  (cost=145456 rows=99550) (actual time=0.0729..629 rows=20 loops=1)
        -> Invalidate materialized tables (row from t0)  (cost=4992 rows=49775) (actual time=0.00688..0.0749 rows=20 loops=1)
            -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4992 rows=49775) (actual time=0.00657..0.0733 rows=20 loops=1)
        -> Table scan on t2  (cost=2.62 rows=1) (actual time=31.4..31.4 rows=1 loops=20)
            -> Materialize (invalidate on row from t0)  (cost=-1e+12 rows=1) (actual time=31.4..31.4 rows=1 loops=20)
                -> Limit: 1 row(s)  (cost=4826 rows=1) (actual time=31.4..31.4 rows=1 loops=20)
                    -> Filter: ((case when (json_type(json_extract(t1.title,'$."fr"')) = <cache>(('STRING' collate utf8mb4_bin))) then cast(json_unquote(json_ex…
                        -> Index lookup on t1 using PRIMARY (_instance = 'bench')  (cost=4826 rows=48165) (actual time=0.00819..18.1 rows=47492 loops=20)

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
-> Limit: 20 row(s)  (cost=140630 rows=20) (actual time=0.0682..0.502 rows=20 loops=1)
    -> Nested loop left join  (cost=140630 rows=99550) (actual time=0.0674..0.499 rows=20 loops=1)
        -> Invalidate materialized tables (row from t0)  (cost=4992 rows=49775) (actual time=0.0124..0.0404 rows=20 loops=1)
            -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4992 rows=49775) (actual time=0.0121..0.0389 rows=20 loops=1)
        -> Table scan on t2  (cost=2.53 rows=1) (actual time=0.0223..0.0224 rows=1 loops=20)
            -> Materialize (invalidate on row from t0)  (cost=-1e+12 rows=1) (actual time=0.0219..0.0219 rows=1 loops=20)
                -> Limit: 1 row(s)  (cost=0.35 rows=1) (actual time=0.0126..0.0127 rows=1 loops=20)
                    -> Filter: ((t1.__k_title_fr_25b64d40 = left(t0.bookTitle,640)) and ((case when (json_type(json_extract(t1.title,'$."fr"')) = <cache>(('STRI…
                        -> Index lookup on t1 using titleFr (_instance = 'bench', __k_title_fr_25b64d40 = left(t0.bookTitle,640))  (cost=0.35 rows=1) (actual ti…

```

</details>
<details><summary><code>lookup:title:keys:bare</code>: declared index not used</summary>

```sql
SELECT JSON_OBJECT('review', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'rating', CAST(`t1`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t1`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t1`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), 'book', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t2`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t2`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t2`.`category`) AS JSON))), IF(`t2`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t2`.`title`)), JSON_REMOVE(COALESCE(`t2`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"'))) AS `value` FROM (SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`rating`, `t0`.`bookTitle`, `t0`.`bookHeading`, `t0`.`_extra` FROM `nested-bench__reviews` AS `t0` WHERE (`t0`.`_instance` = 'bench') LIMIT 20 OFFSET 0) AS `t1` JOIN `nested-bench__books_bare` AS `t2` ON ((`t2`.`_instance` >= 'bench' AND `t2`.`_instance` <= 'bench') AND (((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t2`.`title`, '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t2`.`title`, '$."fr"')) AS CHAR) END) = `t1`.`bookTitle`)))
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 20 | 100 | NULL
1 | PRIMARY | t2 | range | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using where; Using join buffer (hash join)
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 49775 | 100 | NULL

EXPLAIN ANALYZE
-> Filter: ((case when (json_type(json_extract(t2.title,'$."fr"')) = <cache>(('STRING' collate utf8mb4_bin))) then cast(json_unquote(json_extract(t2.title,'$."f…
    -> Inner hash join (<hash>((case when (json_type(json_extract(t2.title,'$."fr"')) = <cache>(('STRING' collate utf8mb4_bin))) then cast(json_unquote(json_ext…
        -> Filter: ((t2._instance >= 'bench') and (t2._instance <= 'bench'))  (cost=5067 rows=48165) (actual time=0.00792..61.8 rows=100000 loops=1)
            -> Index range scan on t2 using PRIMARY over (_instance = 'bench')  (cost=5067 rows=48165) (actual time=0.00674..53.6 rows=100000 loops=1)
        -> Hash
            -> Table scan on t1  (cost=4997..4999 rows=20) (actual time=0.0317..0.034 rows=20 loops=1)
                -> Materialize  (cost=4997..4997 rows=20) (actual time=0.0308..0.0308 rows=20 loops=1)
                    -> Limit: 20 row(s)  (cost=4992 rows=20) (actual time=0.00496..0.0153 rows=20 loops=1)
                        -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4992 rows=49775) (actual time=0.00472..0.0141 rows=20 loops=1)

```

</details>
<details><summary><code>lookup:title:keys:indexed</code>: declared index titleFr</summary>

```sql
SELECT JSON_OBJECT('review', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'rating', CAST(`t1`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t1`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t1`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), 'book', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t2`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t2`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t2`.`category`) AS JSON))), IF(`t2`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t2`.`title`)), JSON_REMOVE(COALESCE(`t2`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"'))) AS `value` FROM (SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`rating`, `t0`.`bookTitle`, `t0`.`bookHeading`, `t0`.`_extra` FROM `nested-bench__reviews` AS `t0` WHERE (`t0`.`_instance` = 'bench') LIMIT 20 OFFSET 0) AS `t1` JOIN `nested-bench__books_indexed` AS `t2` ON ((`t2`.`_instance` = 'bench') AND ((`t2`.`__k_title_fr_25b64d40` = LEFT(`t1`.`bookTitle`, 640) AND (CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t2`.`title`, '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t2`.`title`, '$."fr"')) AS CHAR) END) = `t1`.`bookTitle`)))
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 20 | 100 | NULL
1 | PRIMARY | t2 | ref | PRIMARY,titleFr,internalTitleFr | titleFr | 3077 | 1 | 100 | Using where
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 49775 | 100 | NULL

EXPLAIN ANALYZE
-> Nested loop inner join  (cost=5006 rows=20) (actual time=0.0533..0.206 rows=20 loops=1)
    -> Table scan on t1  (cost=4997..4999 rows=20) (actual time=0.0355..0.039 rows=20 loops=1)
        -> Materialize  (cost=4997..4997 rows=20) (actual time=0.034..0.034 rows=20 loops=1)
            -> Limit: 20 row(s)  (cost=4992 rows=20) (actual time=0.00887..0.0168 rows=20 loops=1)
                -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4992 rows=49775) (actual time=0.00817..0.0151 rows=20 loops=1)
    -> Filter: ((t2.__k_title_fr_25b64d40 = left(t1.bookTitle,640)) and ((case when (json_type(json_extract(t2.title,'$."fr"')) = <cache>(('STRING' collate utf8…
        -> Index lookup on t2 using titleFr (_instance = 'bench', __k_title_fr_25b64d40 = left(t1.bookTitle,640))  (cost=0.255 rows=1) (actual time=0.0072..0.00…

```

</details>
<details><summary><code>lookup:heading:path:bare</code>: declared index not used</summary>

```sql
SELECT JSON_SET(JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t0`.`_instance`, '')) AS JSON), 'rating', CAST(`t0`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t0`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t0`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t0`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), '$."bookHeading"', `t2`.`value`) AS `value` FROM `nested-bench__reviews` AS `t0` LEFT JOIN LATERAL (SELECT JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t1`.`category`) AS JSON))), IF(`t1`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t1`.`title`)), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"')) AS `value` FROM `nested-bench__books_bare` AS `t1` WHERE (`t1`.`_instance` = 'bench') AND ((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`_extra`, '$."_internal"."data"."title"."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t1`.`_extra`, '$."_internal"."data"."title"."fr"')) AS CHAR) END) = `t0`.`bookHeading`) LIMIT 1) AS `t2` ON TRUE WHERE (`t0`.`_instance` = 'bench') LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | t0 | ref | PRIMARY | PRIMARY | 514 | 49775 | 100 | Rematerialize (<derived2>)
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 2 | 100 | Using where
2 | DEPENDENT DERIVED | t1 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using where

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=145456 rows=20) (actual time=0.0415..776 rows=20 loops=1)
    -> Nested loop left join  (cost=145456 rows=99550) (actual time=0.0409..776 rows=20 loops=1)
        -> Invalidate materialized tables (row from t0)  (cost=4992 rows=49775) (actual time=0.00608..0.0674 rows=20 loops=1)
            -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4992 rows=49775) (actual time=0.0058..0.0651 rows=20 loops=1)
        -> Table scan on t2  (cost=2.62 rows=1) (actual time=38.8..38.8 rows=1 loops=20)
            -> Materialize (invalidate on row from t0)  (cost=-1e+12 rows=1) (actual time=38.8..38.8 rows=1 loops=20)
                -> Limit: 1 row(s)  (cost=4826 rows=1) (actual time=38.8..38.8 rows=1 loops=20)
                    -> Filter: ((case when (json_type(json_extract(t1._extra,'$."_internal"."data"."title"."fr"')) = <cache>(('STRING' collate utf8mb4_bin))) th…
                        -> Index lookup on t1 using PRIMARY (_instance = 'bench')  (cost=4826 rows=48165) (actual time=0.00755..18.2 rows=47434 loops=20)

```

</details>
