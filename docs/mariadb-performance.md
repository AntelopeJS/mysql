---
title: MariaDB performance
description: How fast MariaDB 11.8 and 12.3 read nested fields beside MySQL and PostgreSQL, and why.
mode: reference
---

The nested-field benchmark in [`bench/RESULTS.md`](../bench/RESULTS.md) runs on MariaDB 11.8 and 12.3 beside MySQL and PostgreSQL 18. A declared index serves every read it serves on MySQL, in 0.4 to 1.6 ms. Without an index, MariaDB takes 2.5 to 44 times PostgreSQL's time on 15 of the 26 queries in the latest run, and [`bench/findings.md`](../bench/findings.md) gives the cause of each:

- MariaDB stores JSON as text, so reading a path costs more the longer the document is. One `JSON_EXTRACT` of a 430-byte document over 100,000 rows takes about 110 ms, against 16 ms on MySQL 8.4. A filter that compares a read with a string tests its `JSON_VALUE` first, which took about a third of that on the bench's documents.
- MariaDB has no hash join at its default `join_cache_level`. A join no index serves evaluates its condition once per pair of rows in the join buffer.
- A sort over a value of no declared type reads the document once per term of MySQL's JSON order.

Declare an index on a nested path that a filter, sort or join reads, and the read goes through its key column on both engines.
