# 9.7: orderBy, then slice(0, 20)

The statements the module sent, from the server's own log, and their plans. Back to [RESULTS.md](../RESULTS.md).

<details><summary><code>orderBy:title:path:bare</code>: declared index not used</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench') ORDER BY (CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) AS CHAR) END) ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using filesort

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=113..113 rows=20 loops=1)
    -> Sort row IDs: (case when (json_type(json_extract(t0.title,'$."fr"')) = ('STRING' collate utf8mb4_bin)) then cast(json_unquote(json_extract(t0.title,'$."f…
        -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4826 rows=48165) (actual time=0.00312..30.7 rows=100000 loops=1)

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
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=0.0152..0.0803 rows=20 loops=1)
    -> Index lookup on t0 using titleFr (_instance = 'bench')  (cost=4826 rows=48165) (actual time=0.0148..0.0789 rows=20 loops=1)

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
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=205..205 rows=20 loops=1)
    -> Sort: (case when (json_type(json_extract(json_object('_id',cast(json_quote(t0._id) as json),'sortKey',cast(json_quote((case when (json_type(json_extract(…
        -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4826 rows=48165) (actual time=0.00286..36.7 rows=100000 loops=1)

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
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=207..207 rows=20 loops=1)
    -> Sort: (case when (json_type(json_extract(json_object('_id',cast(json_quote(t0._id) as json),'sortKey',cast(json_quote((case when (json_type(json_extract(…
        -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4826 rows=48165) (actual time=0.00509..37.5 rows=100000 loops=1)

```

</details>
<details><summary><code>orderBy:heading:path:bare</code>: declared index not used</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench') ORDER BY JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"') ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using filesort

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=107..107 rows=20 loops=1)
    -> Sort row IDs: json_extract(t0._extra,'$."_internal"."data"."title"."fr"'), limit input to 20 row(s) per chunk  (cost=4826 rows=48165) (actual time=107..1…
        -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4826 rows=48165) (actual time=0.00477..30.3 rows=100000 loops=1)

```

</details>
<details><summary><code>orderBy:heading:path:indexed</code>: declared index internalTitleFr</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_indexed` AS `t0` WHERE (`t0`.`_instance` = 'bench') ORDER BY `t0`.`__k__internal_data_title_fr_eccf6ec9` ASC, `t0`.`__k__internal_data_title_fr_4d9576e9` ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 514 | 48165 | 100 | NULL

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=0.0195..0.0916 rows=20 loops=1)
    -> Index lookup on t0 using internalTitleFr (_instance = 'bench')  (cost=4826 rows=48165) (actual time=0.0192..0.0901 rows=20 loops=1)

```

</details>
<details><summary><code>orderBy:heading:keys:bare</code>: declared index not used</summary>

```sql
SELECT `t1`.`value` AS `value` FROM (SELECT JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), 'sortKey', JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) AS `value` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench')) AS `t1` ORDER BY JSON_EXTRACT(`t1`.`value`, '$."sortKey"') ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using filesort

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=104..104 rows=20 loops=1)
    -> Sort: json_extract(json_object('_id',cast(json_quote(t0._id) as json),'sortKey',json_extract(t0._extra,'$."_internal"."data"."title"."fr"')),'$."sortKey"…
        -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4826 rows=48165) (actual time=0.00328..28 rows=100000 loops=1)

```

</details>
<details><summary><code>orderBy:heading:keys:indexed</code>: declared index not used</summary>

```sql
SELECT `t1`.`value` AS `value` FROM (SELECT JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), 'sortKey', JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) AS `value` FROM `nested-bench__books_indexed` AS `t0` WHERE (`t0`.`_instance` = 'bench')) AS `t1` ORDER BY JSON_EXTRACT(`t1`.`value`, '$."sortKey"') ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY,titleFr,internalTitleFr | PRIMARY | 514 | 48165 | 100 | Using filesort

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=105..105 rows=20 loops=1)
    -> Sort: json_extract(json_object('_id',cast(json_quote(t0._id) as json),'sortKey',json_extract(t0._extra,'$."_internal"."data"."title"."fr"')),'$."sortKey"…
        -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4826 rows=48165) (actual time=0.00506..28.9 rows=100000 loops=1)

```

</details>
<details><summary><code>orderBy:heading:decorators:bare</code>: declared index not used</summary>

```sql
SELECT `t1`.`value` AS `value` FROM (SELECT JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), 'sortKey', COALESCE(NULLIF(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"'), CAST('null' AS JSON)), JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."en"'))) AS `value` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench')) AS `t1` ORDER BY JSON_EXTRACT(`t1`.`value`, '$."sortKey"') ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using filesort

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=132..132 rows=20 loops=1)
    -> Sort: json_extract(json_object('_id',cast(json_quote(t0._id) as json),'sortKey',coalesce(nullif(json_extract(t0._extra,'$."_internal"."data"."title"."fr"…
        -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4826 rows=48165) (actual time=0.00523..28.7 rows=100000 loops=1)

```

</details>
<details><summary><code>orderBy:heading:decorators:indexed</code>: declared index not used</summary>

```sql
SELECT `t1`.`value` AS `value` FROM (SELECT JSON_OBJECT('_id', CAST(JSON_QUOTE(`t0`.`_id`) AS JSON), 'sortKey', COALESCE(NULLIF(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"'), CAST('null' AS JSON)), JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."en"'))) AS `value` FROM `nested-bench__books_indexed` AS `t0` WHERE (`t0`.`_instance` = 'bench')) AS `t1` ORDER BY JSON_EXTRACT(`t1`.`value`, '$."sortKey"') ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY,titleFr,internalTitleFr | PRIMARY | 514 | 48165 | 100 | Using filesort

EXPLAIN ANALYZE
-> Limit: 20 row(s)  (cost=4826 rows=20) (actual time=133..133 rows=20 loops=1)
    -> Sort: json_extract(json_object('_id',cast(json_quote(t0._id) as json),'sortKey',coalesce(nullif(json_extract(t0._extra,'$."_internal"."data"."title"."fr"…
        -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4826 rows=48165) (actual time=0.00496..29.6 rows=100000 loops=1)

```

</details>
