# MariaDB 12.3: orderBy, then slice(0, 20)

The statements the module sent, from the server's own log, and their plans. Back to [RESULTS.md](../RESULTS.md).

<details><summary><code>orderBy:title:path:bare</code>: declared index not used</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench') ORDER BY (CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) AS CHAR) END) ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY | PRIMARY | 514 | 96444 | 100 | Using where; Using filesort

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY | PRIMARY | 514 | NULL | 96444 | 20.00 | 100 | 100 | Using where; Using filesort
```

</details>
<details><summary><code>orderBy:title:path:indexed</code>: declared index titleFr</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_indexed` AS `t0` WHERE (`t0`.`_instance` = 'bench') ORDER BY `t0`.`__k_title_fr_25b64d40` ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY,titleFr,internalTitleFr | titleFr | 514 | 96444 | 100 | Using where

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY,titleFr,internalTitleFr | titleFr | 514 | NULL | 96444 | 20.00 | 100 | 100 | Using where
```

</details>
<details><summary><code>orderBy:title:keys:bare</code>: declared index not used</summary>

```sql
SELECT `t1`.`value` AS `value` FROM (SELECT JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t0`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'sortKey', JSON_EXTRACT(CONVERT(JSON_QUOTE((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) AS CHAR) END)) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$')) AS `value` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench')) AS `t1` ORDER BY (CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) AS CHAR) END) ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY | PRIMARY | 514 | 96444 | 100 | Using where; Using filesort

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY | PRIMARY | 514 | NULL | 96444 | 20.00 | 100 | 100 | Using where; Using filesort
```

</details>
<details><summary><code>orderBy:title:keys:indexed</code>: declared index not used</summary>

```sql
SELECT `t1`.`value` AS `value` FROM (SELECT JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t0`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'sortKey', JSON_EXTRACT(CONVERT(JSON_QUOTE((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t0`.`title`, '$."fr"')) AS CHAR) END)) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$')) AS `value` FROM `nested-bench__books_indexed` AS `t0` WHERE (`t0`.`_instance` = 'bench')) AS `t1` ORDER BY (CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) AS CHAR) END) ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY,titleFr,internalTitleFr | PRIMARY | 514 | 96444 | 100 | Using where; Using filesort

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY,titleFr,internalTitleFr | PRIMARY | 514 | NULL | 96444 | 20.00 | 100 | 100 | Using where; Using filesort
```

</details>
<details><summary><code>orderBy:heading:path:bare</code>: declared index not used</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench') ORDER BY COALESCE((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CONCAT('2', CAST(JSON_UNQUOTE(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) AS CHAR)) WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) IN ('INTEGER' COLLATE utf8mb4_bin, 'UNSIGNED INTEGER' COLLATE utf8mb4_bin, 'DOUBLE' COLLATE utf8mb4_bin, 'DECIMAL' COLLATE utf8mb4_bin)) THEN '1' WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) IN ('BOOLEAN' COLLATE utf8mb4_bin)) THEN '5' WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) IN ('OBJECT' COLLATE utf8mb4_bin)) THEN CONCAT('3', CAST(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"') AS CHAR)) WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) IN ('ARRAY' COLLATE utf8mb4_bin)) THEN CONCAT('4', CAST(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"') AS CHAR)) WHEN (JSON_TYPE(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) IN ('NULL' COLLATE utf8mb4_bin)) THEN NULL ELSE CONCAT('6', CAST(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"') AS CHAR)) END), '0') ASC, (CASE WHEN JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."f …(2130 chars)
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY | PRIMARY | 514 | 96444 | 100 | Using where; Using filesort

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY | PRIMARY | 514 | NULL | 96444 | 20.00 | 100 | 100 | Using where; Using filesort
```

</details>
<details><summary><code>orderBy:heading:path:indexed</code>: declared index internalTitleFr</summary>

```sql
SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`category`, `t0`.`title`, `t0`.`_extra` FROM `nested-bench__books_indexed` AS `t0` WHERE (`t0`.`_instance` = 'bench') ORDER BY `t0`.`__k__internal_data_title_fr_eccf6ec9` ASC, `t0`.`__k__internal_data_title_fr_4d9576e9` ASC LIMIT 20 OFFSET 0
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 514 | 96444 | 100 | Using where

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 514 | NULL | 96444 | 20.00 | 100 | 100 | Using where
```

</details>
<details><summary><code>orderBy:heading:keys:bare</code>: declared index not used</summary>

```sql
SELECT `t1`.`value` AS `value` FROM (SELECT JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t0`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'sortKey', JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) AS `value` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench')) AS `t1` ORDER BY COALESCE((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CONCAT('2', CAST(JSON_UNQUOTE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) AS CHAR)) WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('INTEGER' COLLATE utf8mb4_bin, 'UNSIGNED INTEGER' COLLATE utf8mb4_bin, 'DOUBLE' COLLATE utf8mb4_bin, 'DECIMAL' COLLATE utf8mb4_bin)) THEN '1' WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('BOOLEAN' COLLATE utf8mb4_bin)) THEN '5' WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('OBJECT' COLLATE utf8mb4_bin)) THEN CONCAT('3', CAST(JSON_EXTRACT(`t1`.`value`, '$."sortKey"') AS CHAR)) WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('ARRAY' COLLATE utf8mb4_bin)) THEN CONCAT('4', CAST(JSON_EXTRACT(`t1`.`value`, '$."sortKey"') AS CHAR)) WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('NULL' COLLATE utf8mb4_bin)) THEN NULL ELSE CONCAT('6', CAST(JSON_EXTRACT(`t1`.`value`, '$."sortKey"') AS CHAR)) END), '0') ASC, (CASE WHEN JSON_EXTRACT(`t1`.`value`, '$."sortKey"') IS NULL THEN NULL WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) …(1957 chars)
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY | PRIMARY | 514 | 96444 | 100 | Using where; Using filesort

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY | PRIMARY | 514 | NULL | 96444 | 20.00 | 100 | 100 | Using where; Using filesort
```

</details>
<details><summary><code>orderBy:heading:keys:indexed</code>: declared index not used</summary>

```sql
SELECT `t1`.`value` AS `value` FROM (SELECT JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t0`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'sortKey', JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"')) AS `value` FROM `nested-bench__books_indexed` AS `t0` WHERE (`t0`.`_instance` = 'bench')) AS `t1` ORDER BY COALESCE((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CONCAT('2', CAST(JSON_UNQUOTE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) AS CHAR)) WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('INTEGER' COLLATE utf8mb4_bin, 'UNSIGNED INTEGER' COLLATE utf8mb4_bin, 'DOUBLE' COLLATE utf8mb4_bin, 'DECIMAL' COLLATE utf8mb4_bin)) THEN '1' WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('BOOLEAN' COLLATE utf8mb4_bin)) THEN '5' WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('OBJECT' COLLATE utf8mb4_bin)) THEN CONCAT('3', CAST(JSON_EXTRACT(`t1`.`value`, '$."sortKey"') AS CHAR)) WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('ARRAY' COLLATE utf8mb4_bin)) THEN CONCAT('4', CAST(JSON_EXTRACT(`t1`.`value`, '$."sortKey"') AS CHAR)) WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('NULL' COLLATE utf8mb4_bin)) THEN NULL ELSE CONCAT('6', CAST(JSON_EXTRACT(`t1`.`value`, '$."sortKey"') AS CHAR)) END), '0') ASC, (CASE WHEN JSON_EXTRACT(`t1`.`value`, '$."sortKey"') IS NULL THEN NULL WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey" …(1960 chars)
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY,titleFr,internalTitleFr | PRIMARY | 514 | 96444 | 100 | Using where; Using filesort

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY,titleFr,internalTitleFr | PRIMARY | 514 | NULL | 96444 | 20.00 | 100 | 100 | Using where; Using filesort
```

</details>
<details><summary><code>orderBy:heading:decorators:bare</code>: declared index not used</summary>

```sql
SELECT `t1`.`value` AS `value` FROM (SELECT JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t0`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'sortKey', COALESCE(NULLIF(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"'), JSON_EXTRACT(CONVERT('null' USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$')), JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."en"'))) AS `value` FROM `nested-bench__books_bare` AS `t0` WHERE (`t0`.`_instance` = 'bench')) AS `t1` ORDER BY COALESCE((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CONCAT('2', CAST(JSON_UNQUOTE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) AS CHAR)) WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('INTEGER' COLLATE utf8mb4_bin, 'UNSIGNED INTEGER' COLLATE utf8mb4_bin, 'DOUBLE' COLLATE utf8mb4_bin, 'DECIMAL' COLLATE utf8mb4_bin)) THEN '1' WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('BOOLEAN' COLLATE utf8mb4_bin)) THEN '5' WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('OBJECT' COLLATE utf8mb4_bin)) THEN CONCAT('3', CAST(JSON_EXTRACT(`t1`.`value`, '$."sortKey"') AS CHAR)) WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('ARRAY' COLLATE utf8mb4_bin)) THEN CONCAT('4', CAST(JSON_EXTRACT(`t1`.`value`, '$."sortKey"') AS CHAR)) WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('NULL' COLLATE utf8mb4_bin)) THEN NULL ELSE CONCAT('6', CAST(JSON_EXTRACT(`t1`.`value`, '$."sort …(2119 chars)
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY | PRIMARY | 514 | 96444 | 100 | Using where; Using filesort

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY | PRIMARY | 514 | NULL | 96444 | 20.00 | 100 | 100 | Using where; Using filesort
```

</details>
<details><summary><code>orderBy:heading:decorators:indexed</code>: declared index not used</summary>

```sql
SELECT `t1`.`value` AS `value` FROM (SELECT JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t0`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'sortKey', COALESCE(NULLIF(JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."fr"'), JSON_EXTRACT(CONVERT('null' USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$')), JSON_EXTRACT(`t0`.`_extra`, '$."_internal"."data"."title"."en"'))) AS `value` FROM `nested-bench__books_indexed` AS `t0` WHERE (`t0`.`_instance` = 'bench')) AS `t1` ORDER BY COALESCE((CASE WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('STRING' COLLATE utf8mb4_bin)) THEN CONCAT('2', CAST(JSON_UNQUOTE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) AS CHAR)) WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('INTEGER' COLLATE utf8mb4_bin, 'UNSIGNED INTEGER' COLLATE utf8mb4_bin, 'DOUBLE' COLLATE utf8mb4_bin, 'DECIMAL' COLLATE utf8mb4_bin)) THEN '1' WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('BOOLEAN' COLLATE utf8mb4_bin)) THEN '5' WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('OBJECT' COLLATE utf8mb4_bin)) THEN CONCAT('3', CAST(JSON_EXTRACT(`t1`.`value`, '$."sortKey"') AS CHAR)) WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('ARRAY' COLLATE utf8mb4_bin)) THEN CONCAT('4', CAST(JSON_EXTRACT(`t1`.`value`, '$."sortKey"') AS CHAR)) WHEN (JSON_TYPE(JSON_EXTRACT(`t1`.`value`, '$."sortKey"')) IN ('NULL' COLLATE utf8mb4_bin)) THEN NULL ELSE CONCAT('6', CAST(JSON_EXTRACT(`t1`.`value`, '$."s …(2122 chars)
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY,titleFr,internalTitleFr | PRIMARY | 514 | 96444 | 100 | Using where; Using filesort

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | t0 | range | PRIMARY,titleFr,internalTitleFr | PRIMARY | 514 | NULL | 96444 | 20.00 | 100 | 100 | Using where; Using filesort
```

</details>
