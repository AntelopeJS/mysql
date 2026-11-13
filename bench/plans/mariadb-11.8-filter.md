# MariaDB 11.8: Filter on equality

The statements the module sent, from the server's own log, and their plans. Back to [RESULTS.md](../RESULTS.md).

<details><summary><code>filter:title:keys:bare</code>: declared index not used</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench') AND (((CAST(JSON_VALUE(`t0`.`title`, '$."fr"') AS CHAR) = 'titre 067999') AND ((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) AS CHAR) END) = 'titre 067999')))
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ALL | PRIMARY | NULL | NULL | 96444 | 100 | Using where

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | t0 | ALL | PRIMARY | NULL | NULL | NULL | 96444 | 100000.00 | 100 | 0 | Using where
```

</details>
<details><summary><code>filter:title:keys:indexed</code>: declared index titleFr</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_indexed` AS `t0` WHERE (`t0`.`_instance` = 'bench') AND ((`t0`.`__k_title_fr_25b64d40` = LEFT('titre 067999', 640) AND (CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) AS CHAR) END) = 'titre 067999'))
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY,titleFr,internalTitleFr | titleFr | 3077 | 1 | 100 | Using where

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY,titleFr,internalTitleFr | titleFr | 3077 | const,const | 1 | 1.00 | 100 | 100 | Using where
```

</details>
<details><summary><code>filter:heading:keys:bare</code>: declared index not used</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench') AND (((CAST(JSON_VALUE(`t0`.`_extra`, '$."_internal"."data"."title"."fr"') AS CHAR) = 'intitulé 016147') AND ((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) AS CHAR) END) = 'intitulé 016147')))
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ALL | PRIMARY | NULL | NULL | 96444 | 100 | Using where

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | t0 | ALL | PRIMARY | NULL | NULL | NULL | 96444 | 100000.00 | 100 | 0 | Using where
```

</details>
<details><summary><code>filter:heading:keys:indexed</code>: declared index internalTitleFr</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_indexed` AS `t0` WHERE (`t0`.`_instance` = 'bench') AND ((`t0`.`__k__internal_data_title_fr_eccf6ec9` = LEFT(CONCAT('2', 'intitulé 016147'), 638) AND (CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) AS CHAR) END) = 'intitulé 016147'))
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 3069 | 1 | 100 | Using where

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | t0 | ref | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 3069 | const,const | 1 | 1.00 | 100 | 100 | Using where
```

</details>
<details><summary><code>filter:heading:decorators:bare</code>: declared index not used</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench') AND (((CAST(JSON_VALUE(`t0`.`_extra`, '$."_internal"."data"."title"."fr"') AS CHAR) = 'intitulé 016147' OR CAST(JSON_VALUE(`t0`.`_extra`, '$."_internal"."data"."title"."en"') AS CHAR) = 'intitulé 016147') AND ((CASE WHEN (JSON_TYPE(COALESCE(JSON_EXTRACT(CONVERT(NULLIF(CAST(JSON_COMPACT(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) AS BINARY), 'null') USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."en"'))) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(COALESCE(JSON_EXTRACT(CONVERT(NULLIF(CAST(JSON_COMPACT(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) AS BINARY), 'null') USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."en"'))) AS CHAR) END) = 'intitulé 016147')))
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ALL | PRIMARY | NULL | NULL | 96444 | 100 | Using where

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | t0 | ALL | PRIMARY | NULL | NULL | NULL | 96444 | 100000.00 | 100 | 0 | Using where
```

</details>
<details><summary><code>filter:heading:decorators:indexed</code>: declared index internalTitleFr</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_indexed` AS `t0` WHERE (`t0`.`_instance` = 'bench') AND (((`t0`.`__k__internal_data_title_fr_eccf6ec9` = LEFT(CONCAT('2', 'intitulé 016147'), 638) OR `t0`.`__k__internal_data_title_fr_eccf6ec9` IS NULL) AND (CASE WHEN (JSON_TYPE(COALESCE(JSON_EXTRACT(CONVERT(NULLIF(CAST(JSON_COMPACT(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) AS BINARY), 'null') USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."en"'))) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(COALESCE(JSON_EXTRACT(CONVERT(NULLIF(CAST(JSON_COMPACT(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) AS BINARY), 'null') USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."en"'))) AS CHAR) END) = 'intitulé 016147'))
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | ref_or_null | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 3069 | 2 | 100 | Using where

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | t0 | ref_or_null | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 3069 | const,const | 2 | 1.00 | 100 | 100 | Using where
```

</details>
