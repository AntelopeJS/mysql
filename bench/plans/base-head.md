# Base and head in the same window

Each round measured the base (bf99ec8) and the code under test back to back on each MySQL-family server, against the same rows, which goes first alternating from round to round, so both sides share the machine's load. Median client ms of each side over its rounds, base → head (head ÷ base). Back to [RESULTS.md](../RESULTS.md).

| query                                                                |                 8.4 |                 9.7 |        MariaDB 11.8 |        MariaDB 12.3 |
| -------------------------------------------------------------------- | ------------------: | ------------------: | ------------------: | ------------------: |
| `filter(key("title").key("fr").eq(v))`                               | 51.1 → 44.1 (0.86×) | 51.8 → 44.6 (0.86×) |  110 → 47.5 (0.43×) |  107 → 49.4 (0.46×) |
| `filter(key("_internal")…key("fr").eq(v))`                           | 66.1 → 51.7 (0.78×) | 67.2 → 53.2 (0.79×) |  308 → 74.3 (0.24×) |  284 → 74.8 (0.26×) |
| `filter(unlockrequest(…, "title", fr).eq(v))`                        |  109 → 52.7 (0.48×) |  109 → 53.3 (0.49×) |   627 → 125 (0.20×) |   589 → 121 (0.21×) |
| `orderBy("title.fr")`                                                |   116 → 115 (1.00×) |   112 → 114 (1.01×) |   132 → 133 (1.01×) |   130 → 126 (0.97×) |
| `map({ sortKey: key("title").key("fr") }).orderBy("sortKey")`        |   209 → 205 (0.98×) |   205 → 206 (1.00×) |   408 → 407 (1.00×) |   422 → 409 (0.97×) |
| `orderBy("_internal.data.title.fr")`                                 |   106 → 106 (1.01×) |   109 → 107 (0.98×) |   718 → 717 (1.00×) |   654 → 660 (1.01×) |
| `map({ sortKey: key("_internal")…key("fr") }).orderBy("sortKey")`    |   101 → 102 (1.01×) |   102 → 102 (1.01×) | 1017 → 1036 (1.02×) |   977 → 974 (1.00×) |
| `map({ sortKey: unlockrequest(…, "title", fr) }).orderBy("sortKey")` |   131 → 129 (0.98×) |   130 → 129 (1.00×) | 2038 → 2118 (1.04×) | 1971 → 1960 (0.99×) |
| `lookup(books, …, "title.fr")`                                       |   498 → 489 (0.98×) |   500 → 498 (1.00×) | 1078 → 1124 (1.04×) | 1021 → 1031 (1.01×) |
| `joinInner(books, key("title").key("fr").eq(review.key))`            | 64.4 → 62.6 (0.97×) | 61.7 → 62.4 (1.01×) |   282 → 291 (1.03×) |   276 → 277 (1.00×) |
| `lookup(books, …, "_internal.data.title.fr")`                        |   639 → 631 (0.99×) |   649 → 676 (1.04×) | 2955 → 3032 (1.03×) | 2703 → 2818 (1.04×) |
| `joinInner(books, key("_internal")…key("fr").eq(review.key))`        | 77.3 → 79.3 (1.03×) | 79.2 → 79.8 (1.01×) |   497 → 506 (1.02×) |   462 → 474 (1.03×) |
| `joinInner(books, unlockrequest(…, "title", fr).eq(review.key))`     |   124 → 122 (0.98×) |   124 → 123 (1.00×) |   815 → 836 (1.03×) |   769 → 770 (1.00×) |

The load average when each run started:

| round | server       | load, base run | load, head run |
| ----: | ------------ | -------------: | -------------: |
|     1 | 8.4          |           4.31 |           3.46 |
|     1 | 9.7          |           3.61 |           3.08 |
|     1 | MariaDB 11.8 |           8.90 |           5.94 |
|     1 | MariaDB 12.3 |           5.05 |           3.03 |
|     2 | 8.4          |           4.08 |           4.35 |
|     2 | 9.7          |           2.92 |           3.88 |
|     2 | MariaDB 11.8 |           4.29 |           3.17 |
|     2 | MariaDB 12.3 |           3.60 |           3.02 |
|     3 | 8.4          |           4.20 |           4.56 |
|     3 | 9.7          |           3.45 |           4.41 |
|     3 | MariaDB 11.8 |           4.01 |           3.38 |
|     3 | MariaDB 12.3 |           5.24 |           3.35 |
