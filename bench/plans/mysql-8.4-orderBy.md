# 8.4: orderBy, then slice(0, 20)

The statements the module sent, from the server's own log, and their plans. Back to [RESULTS.md](../RESULTS.md).

<details><summary><code>orderBy:title:path:bare</code>: declared index not used</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench') ORDER BY JSON_EXTRACT(`t0`.`_extra`, '$."title.fr"') ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using filesort

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=175..175 rows=20 loops=1)
    -> Sort row IDs: json_extract(t0._extra,'$."title.fr"'), limit input to 20 row(s) per chunk  (cost=4826 rows=48165) (actual time=175..175 rows=20 loops=1)
        -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4826 rows=48165) (actual time=0.0124..57.8 rows=100000 loops=1)

```

</details>
<details><summary><code>orderBy:title:path:indexed</code>: declared index titleFr</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_indexed` AS `t0` WHERE (`t0`.`_instance` = 'bench') ORDER BY `t0`.`__k_title_fr_25b64d40` ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY,titleFr,internalTitleFr | titleFr | 514 | 48165 | 100 | NULL

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=0.0266..0.143 rows=20 loops=1)
    -> Index lookup on t0 using titleFr (_instance='bench')  (cost=4826 rows=48165) (actual time=0.0262..0.141 rows=20 loops=1)

```

</details>
<details><summary><code>orderBy:title:keys:bare</code>: declared index not used</summary>

```sql
SELECT `t1`.`value` AS `value` FROM (SELECT JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), 'sortKey', CAST(JSON_QUOTE((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) AS CHAR) END)) AS JSON)) AS `value` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench')) AS `t1` ORDER BY (CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) AS CHAR) END) ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using filesort

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=330..330 rows=20 loops=1)
    -> Sort: (case when (json_type(json_extract(json_object('_id',cast(json_quote(t0._id) as json),'sortKey',cast(json_quote((case when (json_type(json_extract(…
        -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4826 rows=48165) (actual time=0.00528..63.2 rows=100000 loops=1)

```

</details>
<details><summary><code>orderBy:title:keys:indexed</code>: declared index not used</summary>

```sql
SELECT `t1`.`value` AS `value` FROM (SELECT JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), 'sortKey', CAST(JSON_QUOTE((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) AS CHAR) END)) AS JSON)) AS `value` FROM `nested-bench__books_indexed` AS `t0` WHERE (`t0`.`_instance` = 'bench')) AS `t1` ORDER BY (CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) AS CHAR) END) ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY,titleFr,internalTitleFr | PRIMARY | 514 | 48165 | 100 | Using filesort

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=346..346 rows=20 loops=1)
    -> Sort: (case when (json_type(json_extract(json_object('_id',cast(json_quote(t0._id) as json),'sortKey',cast(json_quote((case when (json_type(json_extract(…
        -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4826 rows=48165) (actual time=0.0151..68.5 rows=100000 loops=1)

```

</details>
<details><summary><code>orderBy:heading:path:bare</code>: declared index not used</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench') ORDER BY JSON_EXTRACT(`t0`.`_extra`, '$."_internal.data.title.fr"') ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using filesort

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=146..147 rows=20 loops=1)
    -> Sort row IDs: json_extract(t0._extra,'$."_internal.data.title.fr"'), limit input to 20 row(s) per chunk  (cost=4826 rows=48165) (actual time=146..147 row…
        -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4826 rows=48165) (actual time=0.0102..54 rows=100000 loops=1)

```

</details>
<details><summary><code>orderBy:heading:path:indexed</code>: declared index internalTitleFr</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_indexed` AS `t0` WHERE (`t0`.`_instance` = 'bench') ORDER BY `t0`.`__k__internal_data_title_fr_cca329fe` ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 514 | 48165 | 100 | NULL

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=0.0276..0.128 rows=20 loops=1)
    -> Index lookup on t0 using internalTitleFr (_instance='bench')  (cost=4826 rows=48165) (actual time=0.0269..0.126 rows=20 loops=1)

```

</details>
<details><summary><code>orderBy:heading:keys:bare</code>: declared index not used</summary>

```sql
SELECT `t1`.`value` AS `value` FROM (SELECT JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), 'sortKey', JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"'), '$."data"'), '$."title"'), '$."fr"')) AS `value` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench')) AS `t1` ORDER BY JSON_EXTRACT(`t1`.`value`, '$."sortKey"') ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using filesort

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=166..166 rows=20 loops=1)
    -> Sort: json_extract(json_object('_id',cast(json_quote(t0._id) as json),'sortKey',json_extract(json_extract(json_extract(json_extract(t0._extra,'$."_intern…
        -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4826 rows=48165) (actual time=0.00621..44.2 rows=100000 loops=1)

```

</details>
<details><summary><code>orderBy:heading:keys:indexed</code>: declared index not used</summary>

```sql
SELECT `t1`.`value` AS `value` FROM (SELECT JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), 'sortKey', JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"'), '$."data"'), '$."title"'), '$."fr"')) AS `value` FROM `nested-bench__books_indexed` AS `t0` WHERE (`t0`.`_instance` = 'bench')) AS `t1` ORDER BY JSON_EXTRACT(`t1`.`value`, '$."sortKey"') ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY,titleFr,internalTitleFr | PRIMARY | 514 | 48165 | 100 | Using filesort

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=156..156 rows=20 loops=1)
    -> Sort: json_extract(json_object('_id',cast(json_quote(t0._id) as json),'sortKey',json_extract(json_extract(json_extract(json_extract(t0._extra,'$."_intern…
        -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4826 rows=48165) (actual time=0.0165..46.5 rows=100000 loops=1)

```

</details>
<details><summary><code>orderBy:heading:decorators:bare</code>: declared index not used</summary>

```sql
SELECT `t1`.`value` AS `value` FROM (SELECT JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), 'sortKey', COALESCE(NULLIF(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"'), '$."data"'), '$."title"'), '$."fr"'), CAST('null' AS JSON)), JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"'), '$."data"'), '$."title"'), '$."en"'))) AS `value` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench')) AS `t1` ORDER BY JSON_EXTRACT(`t1`.`value`, '$."sortKey"') ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using filesort

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=224..224 rows=20 loops=1)
    -> Sort: json_extract(json_object('_id',cast(json_quote(t0._id) as json),'sortKey',coalesce(nullif(json_extract(json_extract(json_extract(json_extract(t0._e…
        -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4826 rows=48165) (actual time=0.0114..50.6 rows=100000 loops=1)

```

</details>
<details><summary><code>orderBy:heading:decorators:indexed</code>: declared index not used</summary>

```sql
SELECT `t1`.`value` AS `value` FROM (SELECT JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), 'sortKey', COALESCE(NULLIF(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"'), '$."data"'), '$."title"'), '$."fr"'), CAST('null' AS JSON)), JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"'), '$."data"'), '$."title"'), '$."en"'))) AS `value` FROM `nested-bench__books_indexed` AS `t0` WHERE (`t0`.`_instance` = 'bench')) AS `t1` ORDER BY JSON_EXTRACT(`t1`.`value`, '$."sortKey"') ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY,titleFr,internalTitleFr | PRIMARY | 514 | 48165 | 100 | Using filesort

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=187..187 rows=20 loops=1)
    -> Sort: json_extract(json_object('_id',cast(json_quote(t0._id) as json),'sortKey',coalesce(nullif(json_extract(json_extract(json_extract(json_extract(t0._e…
        -> Index lookup on t0 using PRIMARY (_instance='bench')  (cost=4826 rows=48165) (actual time=0.0104..43.7 rows=100000 loops=1)

```

</details>
