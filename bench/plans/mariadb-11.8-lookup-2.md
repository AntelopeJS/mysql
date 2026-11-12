# MariaDB 11.8: Lookup from a 20-review page of the reviews table

The statements the module sent, from the server's own log, and their plans. Back to [RESULTS.md](../RESULTS.md).

<details><summary><code>lookup:heading:keys:indexed</code>: declared index internalTitleFr</summary>

```sql
SELECT JSON_OBJECT('review', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'rating', JSON_EXTRACT(CONVERT(IF(`t1`.`rating` = 0 AND ATAN2(`t1`.`rating`, -1) < 0, '-0', `t1`.`rating`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookTitle', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`bookTitle`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookHeading', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`bookHeading`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), 'book', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t2`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t2`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'category', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t2`.`category`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), IF(`t2`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t2`.`title`)), JSON_REMOVE(COALESCE(`t2`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"'))) AS `value` FROM (SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`r …(2083 chars)
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 20 | 100 |
1 | PRIMARY | t2 | ref | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 3069 | 1 | 100 | Using where
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 99640 | 100 | Using where

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | NULL | 20 | 20.00 | 100 | 100 |
1 | PRIMARY | t2 | ref | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 3069 | const,func | 1 | 1.00 | 100 | 100 | Using where
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | const | 99640 | 20.00 | 100 | 100 | Using where
```

</details>
<details><summary><code>lookup:heading:decorators:bare</code>: declared index not used</summary>

```sql
SELECT JSON_OBJECT('review', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'rating', JSON_EXTRACT(CONVERT(IF(`t1`.`rating` = 0 AND ATAN2(`t1`.`rating`, -1) < 0, '-0', `t1`.`rating`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookTitle', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`bookTitle`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookHeading', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`bookHeading`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), 'book', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t2`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t2`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'category', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t2`.`category`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), IF(`t2`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t2`.`title`)), JSON_REMOVE(COALESCE(`t2`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"'))) AS `value` FROM (SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`r …(2344 chars)
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 20 | 100 |
1 | PRIMARY | t2 | ALL | PRIMARY | NULL | NULL | 96444 | 100 | Using where; Using join buffer (flat, BNL join)
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 99640 | 100 | Using where

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | NULL | 20 | 20.00 | 100 | 100 |
1 | PRIMARY | t2 | ALL | PRIMARY | NULL | NULL | NULL | 96444 | 100000.00 | 100 | 0 | Using where; Using join buffer (flat, BNL join)
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | const | 99640 | 20.00 | 100 | 100 | Using where
```

```sql
SELECT TABLE_TYPE AS kind, TABLE_COMMENT AS comment FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '__antelope_changes'
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | TABLES | ALL | NULL | TABLE_SCHEMA,TABLE_NAME | NULL | NULL | NULL | Using where; Open_frm_only; Scanned 0 databases

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | TABLES | ALL | NULL | TABLE_SCHEMA,TABLE_NAME | NULL | NULL | NULL | 1.00 | NULL | 100 | Using where; Open_frm_only; Scanned 0 databases
```

```sql
SELECT DATABASE() AS name
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | NULL | NULL | NULL | NULL | NULL | NULL | NULL | No tables used

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | No tables used
```

```sql
SELECT GET_LOCK('ajs:reaper:1b32c28cb38c05480eccc1bd60ff97029b57a05c', 0) AS acquired
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | NULL | NULL | NULL | NULL | NULL | NULL | NULL | No tables used

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | No tables used
```

```sql
SELECT `next_seq` AS next_seq, `epoch` AS epoch FROM `__antelope_change_clock` WHERE `id` = 1 FOR UPDATE SKIP LOCKED
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | __antelope_change_clock | const | PRIMARY | PRIMARY | 1 | 1 | 100 |

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | __antelope_change_clock | const | PRIMARY | PRIMARY | 1 | const | 1 | NULL | 100 | NULL |
```

```sql
SELECT `id` AS id FROM `__antelope_changes` WHERE `seq` IS NULL ORDER BY `id` LIMIT 10000 FOR UPDATE SKIP LOCKED
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | __antelope_changes | index | seq | PRIMARY | 8 | 1 | 100 | Using where

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | __antelope_changes | index | seq | PRIMARY | 8 | const | 1 | 0.00 | 100 | 100 | Using where
```

```sql
SELECT MAX(b.`seq`) AS through FROM (SELECT `seq` FROM `__antelope_changes` WHERE `sequenced_at` < UTC_TIMESTAMP(6) - INTERVAL 300000000 MICROSECOND ORDER BY `sequenced_at` LIMIT 10000) AS b
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 2 | 100 |
2 | DERIVED | __antelope_changes | range | sequenced_at | sequenced_at | 9 | 1 | 100 | Using index condition

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | NULL | 2 | 0.00 | 100 | 100 |
2 | DERIVED | __antelope_changes | range | sequenced_at | sequenced_at | 9 | NULL | 1 | 0.00 | 100 | 100 | Using index condition
```

```sql
SELECT RELEASE_LOCK('ajs:reaper:1b32c28cb38c05480eccc1bd60ff97029b57a05c') AS released
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | SIMPLE | NULL | NULL | NULL | NULL | NULL | NULL | NULL | No tables used

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | SIMPLE | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | NULL | No tables used
```

</details>
<details><summary><code>lookup:heading:decorators:indexed</code>: declared index internalTitleFr</summary>

```sql
SELECT JSON_OBJECT('review', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'rating', JSON_EXTRACT(CONVERT(IF(`t1`.`rating` = 0 AND ATAN2(`t1`.`rating`, -1) < 0, '-0', `t1`.`rating`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookTitle', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`bookTitle`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookHeading', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`bookHeading`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), 'book', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t2`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t2`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'category', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t2`.`category`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), IF(`t2`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t2`.`title`)), JSON_REMOVE(COALESCE(`t2`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"'))) AS `value` FROM (SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`r …(2464 chars)
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 20 | 100 |
1 | PRIMARY | t2 | ref_or_null | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 3069 | 2 | 100 | Using where
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 99640 | 100 | Using where

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | NULL | 20 | 20.00 | 100 | 100 |
1 | PRIMARY | t2 | ref_or_null | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 3069 | const,func | 2 | 1.00 | 100 | 100 | Using where
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | const | 99640 | 20.00 | 100 | 100 | Using where
```

</details>
