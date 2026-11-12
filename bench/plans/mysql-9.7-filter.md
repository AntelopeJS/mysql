# 9.7: Filter on equality

The statements the module sent, from the server's own log, and their plans. Back to [RESULTS.md](../RESULTS.md).

<details><summary><code>filter:title:keys:bare</code>: declared index not used</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench') AND (((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) AS CHAR) END) = 'titre 067999'))
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using where

EXPLAIN ANALYZE
-> Filter: ((case when (json_type(json_extract(t0.title,'$."fr"')) = <cache>(('STRING' collate utf8mb4_bin))) then cast(json_unquote(json_extract(t0.title,'$."f…
    -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4826 rows=48165) (actual time=0.00771..31.1 rows=100000 loops=1)

```

</details>
<details><summary><code>filter:title:keys:indexed</code>: declared index titleFr</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_indexed` AS `t0` WHERE (`t0`.`_instance` = 'bench') AND ((`t0`.`__k_title_fr_25b64d40` = LEFT('titre 067999', 640) AND (CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) AS CHAR) END) = 'titre 067999'))
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY,titleFr,internalTitleFr | titleFr | 3077 | 1 | 100 | Using where

EXPLAIN ANALYZE
-> Filter: ((case when (json_type(json_extract(t0.title,'$."fr"')) = <cache>(('STRING' collate utf8mb4_bin))) then cast(json_unquote(json_extract(t0.title,'$."f…
    -> Index lookup on t0 using titleFr (_instance = 'bench', __k_title_fr_25b64d40 = left('titre 067999',640))  (cost=0.35 rows=1) (actual time=0.0149..0.0157 …

```

</details>
<details><summary><code>filter:heading:keys:bare</code>: declared index not used</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench') AND (((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) AS CHAR) END) = 'intitulé 016147'))
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using where

EXPLAIN ANALYZE
-> Filter: ((case when (json_type(json_extract(t0._extra,'$."_internal"."data"."title"."fr"')) = <cache>(('STRING' collate utf8mb4_bin))) then cast(json_unquote…
    -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4826 rows=48165) (actual time=0.00373..31.3 rows=100000 loops=1)

```

</details>
<details><summary><code>filter:heading:keys:indexed</code>: declared index internalTitleFr</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_indexed` AS `t0` WHERE (`t0`.`_instance` = 'bench') AND ((`t0`.`__k__internal_data_title_fr_eccf6ec9` = LEFT(CONCAT('2', 'intitulé 016147'), 638) AND (CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) AS CHAR) END) = 'intitulé 016147'))
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 3069 | 1 | 100 | Using where

EXPLAIN ANALYZE
-> Filter: ((case when (json_type(json_extract(t0._extra,'$."_internal"."data"."title"."fr"')) = <cache>(('STRING' collate utf8mb4_bin))) then cast(json_unquote…
    -> Index lookup on t0 using internalTitleFr (_instance = 'bench', __k__internal_data_title_fr_eccf6ec9 = left(concat('2','intitulé 016147'),638))  (cost=0.3…

```

</details>
<details><summary><code>filter:heading:decorators:bare</code>: declared index not used</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench') AND (((CASE WHEN (JSON_TYPE(COALESCE(NULLIF(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"'), CAST('null' AS JSON)), JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."en"'))) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(COALESCE(NULLIF(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"'), CAST('null' AS JSON)), JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."en"'))) AS CHAR) END) = 'intitulé 016147'))
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY | PRIMARY | 514 | 48165 | 100 | Using where

EXPLAIN ANALYZE
-> Filter: ((case when (json_type(coalesce(nullif(json_extract(t0._extra,'$."_internal"."data"."title"."fr"'),<cache>(cast('null' as json))),json_extract(t0._ex…
    -> Index lookup on t0 using PRIMARY (_instance = 'bench')  (cost=4826 rows=48165) (actual time=0.00379..32.2 rows=100000 loops=1)

```

</details>
<details><summary><code>filter:heading:decorators:indexed</code>: declared index internalTitleFr</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_indexed` AS `t0` WHERE (`t0`.`_instance` = 'bench') AND (((`t0`.`__k__internal_data_title_fr_eccf6ec9` = LEFT(CONCAT('2', 'intitulé 016147'), 638) OR `t0`.`__k__internal_data_title_fr_eccf6ec9` IS NULL) AND (CASE WHEN (JSON_TYPE(COALESCE(NULLIF(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"'), CAST('null' AS JSON)), JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."en"'))) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(COALESCE(NULLIF(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"'), CAST('null' AS JSON)), JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."en"'))) AS CHAR) END) = 'intitulé 016147'))
```

```text
EXPLAIN FORMAT=TRADITIONAL
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref_or_null | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 3069 | 2 | 100 | Using where

EXPLAIN ANALYZE
-> Filter: ((t0._instance = 'bench') and ((t0.__k__internal_data_title_fr_eccf6ec9 = <cache>(left(concat('2','intitulé 016147'),638))) or (t0.__k__internal_data…
    -> Index lookup on t0 using internalTitleFr (_instance = 'bench', __k__internal_data_title_fr_eccf6ec9 = left(concat('2','intitulé 016147'),638) or NULL)  (…

```

</details>
