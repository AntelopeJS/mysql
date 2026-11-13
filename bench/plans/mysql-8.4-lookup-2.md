# 8.4: Lookup from a 20-review page of the reviews table

The statements the module sent, from the server's own log, and their plans. Back to [RESULTS.md](../RESULTS.md).

<details><summary><code>lookup:heading:path:indexed</code>: declared index internalTitleFr</summary>

```sql
SELECT JSON_SET(JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t0`.`_instance`, '')) AS JSON), 'rating', CAST(`t0`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t0`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t0`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t0`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), '$."bookHeading"', `t2`.`value`) AS `value` FROM `nested-bench__reviews` AS `t0` LEFT JOIN LATERAL (SELECT JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t1`.`category`) AS JSON))), IF(`t1`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t1`.`title`)), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"')) AS `value` FROM `nested-bench__books_indexed` AS `t1` WHERE (`t1`.`_instance` = 'bench') AND (`t1`.`__k__internal_data_title_fr_eccf6ec9` = LEFT(CONCAT('2', `t0`.`bookHeading`), 638) AND (CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`_extra`, '$."_internal"."data"."title"."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t1`.`_extra`, '$."_internal"."data"."title"."fr"')) AS CHAR) END) = `t0`.`bookHeading`) LIMIT 1) AS `t2` ON TRUE WHERE (`t0`.`_instance` =  …(1526 chars)
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | t0 | ref | PRIMARY | PRIMARY | 514 | 49775 | 100 | Rematerialize (<derived2>)
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 2 | 100 | Using where
2 | DEPENDENT DERIVED | t1 | ref | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 3069 | 1 | 100 | Using where

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=140630 rows=20) (actual time=0.0358..0.249 rows=20 loops=1)
    -> Nested loop left join  (cost=140630 rows=99550) (actual time=0.0356..0.248 rows=20 loops=1)
        -> Invalidate materialized tables (row from t0)  (cost=4992 rows=49775) (actual time=0.00414..0.0134 rows=20 loops=1)
            -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4992 rows=49775) (actual time=0.00401..0.0125 rows=20 loops=1)
        -> Table scan on t2  (cost=2.53..2.53 rows=1) (actual time=0.0114..0.0115 rows=1 loops=20)
            -> Materialize (invalidate on row from t0)  (cost=0.55..0.55 rows=2) (actual time=0.0113..0.0113 rows=1 loops=20)
                -> Limit: 1 row(s)  (cost=0.35 rows=1) (actual time=0.00714..0.00716 rows=1 loops=20)
                    -> Filter: ((t1.__k__internal_data_title_fr_eccf6ec9 = left(concat('2',t0.bookHeading),638)) and ((case when (json_type(json_extract(t1._ext…
                        -> Index lookup on t1 using internalTitleFr (_instance='bench', __k__internal_data_title_fr_eccf6ec9=left(concat('2',t0.bookHeading),638…

```

</details>
<details><summary><code>lookup:heading:keys:bare</code>: declared index not used</summary>

```sql
SELECT JSON_OBJECT('review', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'rating', CAST(`t1`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t1`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t1`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), 'book', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t2`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t2`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t2`.`category`) AS JSON))), IF(`t2`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t2`.`title`)), JSON_REMOVE(COALESCE(`t2`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"'))) AS `value` FROM (SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`rating`, `t0`.`bookTitle`, `t0`.`bookHeading`, `t0`.`_extra` FROM `nested-bench__reviews` AS `t0` WHERE (`t0`.`_instance` = 'bench') LIMIT 20 OFFSET 0) AS `t1` JOIN `nested-bench__books_bare` AS `t2` ON ((`t2`.`_instance` >= 'bench' AND `t2`.`_instance` <= 'bench') AND (((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t2`.`_extra`, '$."_internal"."data"."title"."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t2`.`_extra`, '$."_internal"."data"."title"."fr"')) AS CHAR) END) = `t1`.`bookH …(1510 chars)
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 20 | 100 | NULL
1 | PRIMARY | t2 | range | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using where; Using join buffer (hash join)
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 49775 | 100 | NULL

EXPLAIN ANALYZE
-> Filter: ((case when (json_type(json_extract(t2._extra,'$."_internal"."data"."title"."fr"')) = <cache>(('STRING' collate utf8mb4_bin))) then cast(json_unquote…
    -> Inner hash join (<hash>((case when (json_type(json_extract(t2._extra,'$."_internal"."data"."title"."fr"')) = <cache>(('STRING' collate utf8mb4_bin))) the…
        -> Filter: ((t2._instance >= 'bench') and (t2._instance <= 'bench'))  (cost=5067 rows=48165) (actual time=0.0138..41 rows=100000 loops=1)
            -> Index range scan on t2 using PRIMARY over (_instance = 'bench')  (cost=5067 rows=48165) (actual time=0.0127..33.7 rows=100000 loops=1)
        -> Hash
            -> Table scan on t1  (cost=4994..4997 rows=20) (actual time=0.0263..0.028 rows=20 loops=1)
                -> Materialize  (cost=4994..4994 rows=20) (actual time=0.0256..0.0256 rows=20 loops=1)
                    -> Limit: 20 row(s)  (cost=4992 rows=20) (actual time=0.00763..0.0145 rows=20 loops=1)
                        -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4992 rows=49775) (actual time=0.00743..0.0134 rows=20 loops=1)

```

</details>
<details><summary><code>lookup:heading:keys:indexed</code>: declared index internalTitleFr</summary>

```sql
SELECT JSON_OBJECT('review', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'rating', CAST(`t1`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t1`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t1`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), 'book', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t2`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t2`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t2`.`category`) AS JSON))), IF(`t2`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t2`.`title`)), JSON_REMOVE(COALESCE(`t2`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"'))) AS `value` FROM (SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`rating`, `t0`.`bookTitle`, `t0`.`bookHeading`, `t0`.`_extra` FROM `nested-bench__reviews` AS `t0` WHERE (`t0`.`_instance` = 'bench') LIMIT 20 OFFSET 0) AS `t1` JOIN `nested-bench__books_indexed` AS `t2` ON ((`t2`.`_instance` = 'bench') AND ((`t2`.`__k__internal_data_title_fr_eccf6ec9` = LEFT(CONCAT('2', `t1`.`bookHeading`), 638) AND (CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t2`.`_extra`, '$."_internal"."data"."title"."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t2`.`_extra`, '$ …(1573 chars)
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 20 | 100 | NULL
1 | PRIMARY | t2 | ref | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 3069 | 1 | 100 | Using where
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 49775 | 100 | NULL

EXPLAIN ANALYZE
-> Nested loop inner join  (cost=5004 rows=20) (actual time=0.0421..0.179 rows=20 loops=1)
    -> Table scan on t1  (cost=4994..4997 rows=20) (actual time=0.0268..0.0292 rows=20 loops=1)
        -> Materialize  (cost=4994..4994 rows=20) (actual time=0.0261..0.0261 rows=20 loops=1)
            -> Limit: 20 row(s)  (cost=4992 rows=20) (actual time=0.00547..0.0123 rows=20 loops=1)
                -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4992 rows=49775) (actual time=0.00513..0.0111 rows=20 loops=1)
    -> Filter: ((t2.__k__internal_data_title_fr_eccf6ec9 = left(concat('2',t1.bookHeading),638)) and ((case when (json_type(json_extract(t2._extra,'$."_internal…
        -> Index lookup on t2 using internalTitleFr (_instance='bench', __k__internal_data_title_fr_eccf6ec9=left(concat('2',t1.bookHeading),638))  (cost=0.255 …

```

</details>
<details><summary><code>lookup:heading:decorators:bare</code>: declared index not used</summary>

```sql
SELECT JSON_OBJECT('review', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'rating', CAST(`t1`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t1`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t1`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), 'book', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t2`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t2`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t2`.`category`) AS JSON))), IF(`t2`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t2`.`title`)), JSON_REMOVE(COALESCE(`t2`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"'))) AS `value` FROM (SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`rating`, `t0`.`bookTitle`, `t0`.`bookHeading`, `t0`.`_extra` FROM `nested-bench__reviews` AS `t0` WHERE (`t0`.`_instance` = 'bench') LIMIT 20 OFFSET 0) AS `t1` JOIN `nested-bench__books_bare` AS `t2` ON ((`t2`.`_instance` >= 'bench' AND `t2`.`_instance` <= 'bench') AND (((CASE WHEN (JSON_TYPE(COALESCE(NULLIF(JSON_EXTRACT(`t2`.`_extra`, '$."_internal"."data"."title"."fr"'), CAST('null' AS JSON)), JSON_EXTRACT(`t2`.`_extra`, '$."_internal"."data"."title"."en"'))) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST( …(1722 chars)
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 20 | 100 | NULL
1 | PRIMARY | t2 | range | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using where; Using join buffer (hash join)
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 49775 | 100 | NULL

EXPLAIN ANALYZE
-> Filter: ((case when (json_type(coalesce(nullif(json_extract(t2._extra,'$."_internal"."data"."title"."fr"'),<cache>(cast('null' as json))),json_extract(t2._ex…
    -> Inner hash join (<hash>((case when (json_type(coalesce(nullif(json_extract(t2._extra,'$."_internal"."data"."title"."fr"'),<cache>(cast('null' as json))),…
        -> Filter: ((t2._instance >= 'bench') and (t2._instance <= 'bench'))  (cost=5067 rows=48165) (actual time=0.00589..44.7 rows=100000 loops=1)
            -> Index range scan on t2 using PRIMARY over (_instance = 'bench')  (cost=5067 rows=48165) (actual time=0.00519..36.8 rows=100000 loops=1)
        -> Hash
            -> Table scan on t1  (cost=4994..4997 rows=20) (actual time=0.0244..0.026 rows=20 loops=1)
                -> Materialize  (cost=4994..4994 rows=20) (actual time=0.0238..0.0238 rows=20 loops=1)
                    -> Limit: 20 row(s)  (cost=4992 rows=20) (actual time=0.0072..0.0139 rows=20 loops=1)
                        -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4992 rows=49775) (actual time=0.007..0.0129 rows=20 loops=1)

```

</details>
<details><summary><code>lookup:heading:decorators:indexed</code>: declared index internalTitleFr</summary>

```sql
SELECT JSON_OBJECT('review', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t1`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) AS JSON), 'rating', CAST(`t1`.`rating` AS JSON), 'bookTitle', CAST(JSON_QUOTE(`t1`.`bookTitle`) AS JSON), 'bookHeading', CAST(JSON_QUOTE(`t1`.`bookHeading`) AS JSON))), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), 'book', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', CAST(JSON_QUOTE(`t2`.`_id`) AS JSON), '_instance', CAST(JSON_QUOTE(NULLIF(`t2`.`_instance`, '')) AS JSON), 'category', CAST(JSON_QUOTE(`t2`.`category`) AS JSON))), IF(`t2`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t2`.`title`)), JSON_REMOVE(COALESCE(`t2`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"'))) AS `value` FROM (SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`rating`, `t0`.`bookTitle`, `t0`.`bookHeading`, `t0`.`_extra` FROM `nested-bench__reviews` AS `t0` WHERE (`t0`.`_instance` = 'bench') LIMIT 20 OFFSET 0) AS `t1` JOIN `nested-bench__books_indexed` AS `t2` ON ((`t2`.`_instance` = 'bench') AND (((`t2`.`__k__internal_data_title_fr_eccf6ec9` = LEFT(CONCAT('2', `t1`.`bookHeading`), 638) OR `t2`.`__k__internal_data_title_fr_eccf6ec9` IS NULL) AND (CASE WHEN (JSON_TYPE(COALESCE(NULLIF(JSON_EXTRACT(`t2`.`_extra`, '$."_internal"."data"."title"."fr"'), CAST('null' AS  …(1842 chars)
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 20 | 100 | NULL
1 | PRIMARY | t2 | ref_or_null | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 3069 | 2 | 100 | Using where
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 49775 | 100 | NULL

EXPLAIN ANALYZE
-> Nested loop inner join  (cost=5011 rows=40) (actual time=0.0464..0.21 rows=20 loops=1)
    -> Table scan on t1  (cost=4994..4997 rows=20) (actual time=0.0269..0.0291 rows=20 loops=1)
        -> Materialize  (cost=4994..4994 rows=20) (actual time=0.026..0.026 rows=20 loops=1)
            -> Limit: 20 row(s)  (cost=4992 rows=20) (actual time=0.00509..0.0122 rows=20 loops=1)
                -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4992 rows=49775) (actual time=0.00474..0.011 rows=20 loops=1)
    -> Filter: ((t2._instance = 'bench') and ((t2.__k__internal_data_title_fr_eccf6ec9 = left(concat('2',t1.bookHeading),638)) or (t2.__k__internal_data_title_f…
        -> Index lookup on t2 using internalTitleFr (_instance='bench', __k__internal_data_title_fr_eccf6ec9=left(concat('2',t1.bookHeading),638) or NULL)  (cos…

```

</details>
