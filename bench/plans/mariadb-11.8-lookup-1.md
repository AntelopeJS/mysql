# MariaDB 11.8: Lookup from a 20-review page of the reviews table

The statements the module sent, from the server's own log, and their plans. Back to [RESULTS.md](../RESULTS.md).

<details><summary><code>lookup:title:path:bare</code>: declared index not used</summary>

```sql
SELECT JSON_SET(JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t0`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t0`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'rating', JSON_EXTRACT(CONVERT(IF(`t0`.`rating` = 0 AND ATAN2(`t0`.`rating`, -1) < 0, '-0', `t0`.`rating`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookTitle', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t0`.`bookTitle`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookHeading', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t0`.`bookHeading`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), JSON_REMOVE(COALESCE(`t0`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), '$."bookTitle"', (SELECT JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'category', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`category`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), IF(`t1`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t1`.`title`)), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"')) AS `value` FROM `nested-bench__books_bare` AS `t1` WHERE ( …(1833 chars)
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | t0 | ref | PRIMARY | PRIMARY | 514 | 99640 | 100 | Using where
2 | DEPENDENT SUBQUERY | t1 | ref | PRIMARY | PRIMARY | 514 | 96444 | 100 | Using where

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | PRIMARY | t0 | ref | PRIMARY | PRIMARY | 514 | const | 99640 | 20.00 | 100 | 100 | Using where
2 | DEPENDENT SUBQUERY | t1 | ref | PRIMARY | PRIMARY | 514 | const | 96444 | 47491.50 | 100 | 0 | Using where
```

</details>
<details><summary><code>lookup:title:path:indexed</code>: declared index titleFr</summary>

```sql
SELECT JSON_SET(JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t0`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t0`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'rating', JSON_EXTRACT(CONVERT(IF(`t0`.`rating` = 0 AND ATAN2(`t0`.`rating`, -1) < 0, '-0', `t0`.`rating`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookTitle', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t0`.`bookTitle`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookHeading', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t0`.`bookHeading`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), JSON_REMOVE(COALESCE(`t0`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), '$."bookTitle"', (SELECT JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'category', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`category`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), IF(`t1`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t1`.`title`)), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"')) AS `value` FROM `nested-bench__books_indexed` AS `t1` WHER …(1899 chars)
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | t0 | ref | PRIMARY | PRIMARY | 514 | 99640 | 100 | Using where
2 | DEPENDENT SUBQUERY | t1 | ref | PRIMARY,titleFr,internalTitleFr | titleFr | 3077 | 1 | 100 | Using where

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | PRIMARY | t0 | ref | PRIMARY | PRIMARY | 514 | const | 99640 | 20.00 | 100 | 100 | Using where
2 | DEPENDENT SUBQUERY | t1 | ref | PRIMARY,titleFr,internalTitleFr | titleFr | 3077 | const,func | 1 | 1.00 | 100 | 100 | Using where
```

</details>
<details><summary><code>lookup:title:keys:bare</code>: declared index not used</summary>

```sql
SELECT JSON_OBJECT('review', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'rating', JSON_EXTRACT(CONVERT(IF(`t1`.`rating` = 0 AND ATAN2(`t1`.`rating`, -1) < 0, '-0', `t1`.`rating`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookTitle', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`bookTitle`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookHeading', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`bookHeading`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), 'book', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t2`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t2`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'category', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t2`.`category`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), IF(`t2`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t2`.`title`)), JSON_REMOVE(COALESCE(`t2`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"'))) AS `value` FROM (SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`r …(1962 chars)
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

</details>
<details><summary><code>lookup:title:keys:indexed</code>: declared index titleFr</summary>

```sql
SELECT JSON_OBJECT('review', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'rating', JSON_EXTRACT(CONVERT(IF(`t1`.`rating` = 0 AND ATAN2(`t1`.`rating`, -1) < 0, '-0', `t1`.`rating`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookTitle', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`bookTitle`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookHeading', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`bookHeading`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), 'book', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t2`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t2`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'category', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t2`.`category`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), IF(`t2`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t2`.`title`)), JSON_REMOVE(COALESCE(`t2`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"'))) AS `value` FROM (SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`r …(1995 chars)
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | 20 | 100 |
1 | PRIMARY | t2 | ref | PRIMARY,titleFr,internalTitleFr | titleFr | 3077 | 1 | 100 | Using where
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | 99640 | 100 | Using where

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | PRIMARY | <derived2> | ALL | NULL | NULL | NULL | NULL | 20 | 20.00 | 100 | 100 |
1 | PRIMARY | t2 | ref | PRIMARY,titleFr,internalTitleFr | titleFr | 3077 | const,func | 1 | 1.00 | 100 | 100 | Using where
2 | DERIVED | t0 | ref | PRIMARY | PRIMARY | 514 | const | 99640 | 20.00 | 100 | 100 | Using where
```

</details>
<details><summary><code>lookup:heading:path:bare</code>: declared index not used</summary>

```sql
SELECT JSON_SET(JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t0`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t0`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'rating', JSON_EXTRACT(CONVERT(IF(`t0`.`rating` = 0 AND ATAN2(`t0`.`rating`, -1) < 0, '-0', `t0`.`rating`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookTitle', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t0`.`bookTitle`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookHeading', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t0`.`bookHeading`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), JSON_REMOVE(COALESCE(`t0`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), '$."bookHeading"', (SELECT JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'category', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`category`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), IF(`t1`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t1`.`title`)), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"')) AS `value` FROM `nested-bench__books_bare` AS `t1` WHERE …(1893 chars)
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | t0 | ref | PRIMARY | PRIMARY | 514 | 99640 | 100 | Using where
2 | DEPENDENT SUBQUERY | t1 | ref | PRIMARY | PRIMARY | 514 | 96444 | 100 | Using where

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | PRIMARY | t0 | ref | PRIMARY | PRIMARY | 514 | const | 99640 | 20.00 | 100 | 100 | Using where
2 | DEPENDENT SUBQUERY | t1 | ref | PRIMARY | PRIMARY | 514 | const | 96444 | 47434.50 | 100 | 0 | Using where
```

</details>
<details><summary><code>lookup:heading:path:indexed</code>: declared index internalTitleFr</summary>

```sql
SELECT JSON_SET(JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t0`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t0`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'rating', JSON_EXTRACT(CONVERT(IF(`t0`.`rating` = 0 AND ATAN2(`t0`.`rating`, -1) < 0, '-0', `t0`.`rating`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookTitle', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t0`.`bookTitle`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookHeading', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t0`.`bookHeading`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), JSON_REMOVE(COALESCE(`t0`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), '$."bookHeading"', (SELECT JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'category', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`category`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), IF(`t1`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t1`.`title`)), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"')) AS `value` FROM `nested-bench__books_indexed` AS `t1` WH …(1989 chars)
```

```text
EXPLAIN EXTENDED
id | select_type | table | type | possible_keys | key | key_len | rows | filtered | Extra
1 | PRIMARY | t0 | ref | PRIMARY | PRIMARY | 514 | 99640 | 100 | Using where
2 | DEPENDENT SUBQUERY | t1 | ref | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 3069 | 1 | 100 | Using where

ANALYZE
id | select_type | table | type | possible_keys | key | key_len | ref | rows | r_rows | filtered | r_filtered | Extra
1 | PRIMARY | t0 | ref | PRIMARY | PRIMARY | 514 | const | 99640 | 20.00 | 100 | 100 | Using where
2 | DEPENDENT SUBQUERY | t1 | ref | PRIMARY,titleFr,internalTitleFr | internalTitleFr | 3069 | const,func | 1 | 1.00 | 100 | 100 | Using where
```

</details>
<details><summary><code>lookup:heading:keys:bare</code>: declared index not used</summary>

```sql
SELECT JSON_OBJECT('review', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t1`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'rating', JSON_EXTRACT(CONVERT(IF(`t1`.`rating` = 0 AND ATAN2(`t1`.`rating`, -1) < 0, '-0', `t1`.`rating`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookTitle', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`bookTitle`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'bookHeading', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t1`.`bookHeading`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), JSON_REMOVE(COALESCE(`t1`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."rating"', '$."bookTitle"', '$."bookHeading"')), 'book', JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('_id', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t2`.`_id`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), '_instance', JSON_EXTRACT(CONVERT(JSON_QUOTE(NULLIF(`t2`.`_instance`, '')) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'), 'category', JSON_EXTRACT(CONVERT(JSON_QUOTE(`t2`.`category`) USING utf8mb4) COLLATE `utf8mb4_nopad_bin`, '$'))), IF(`t2`.`title` IS NULL, JSON_OBJECT(), JSON_OBJECT('title', `t2`.`title`)), JSON_REMOVE(COALESCE(`t2`.`_extra`, JSON_OBJECT()), '$."_id"', '$."_instance"', '$."category"', '$."title"'))) AS `value` FROM (SELECT `t0`.`_id`, `t0`.`_instance`, `t0`.`r …(2020 chars)
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

</details>
