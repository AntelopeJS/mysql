# Documentation

Reference for `@antelopejs/mysql`. The [root README](../README.md) covers installing the module and running a first query. The pages below hold the detail.

|                                                        |                                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| [Storage and schema](./storage.md)                     | What a registered schema becomes in the database, the field-type table, and how registration converges                                |
| [Indexes](./indexes.md)                                | How a declared index becomes a MySQL index, the key columns behind it, and which queries reach it                                     |
| [Configuration](./configuration.md)                    | Every option `construct` accepts                                                                                                      |
| [External mode](./external-mode.md)                    | Reading tables the module did not create, in a database it does not own                                                               |
| [Change feeds](./change-feeds.md)                      | `changes()`, its ordering guarantee, its retention contract and its blind spots                                                       |
| [Errors and refusals](./errors.md)                     | Everything the module refuses, with the message it refuses by                                                                         |
| [MariaDB](./mariadb.md)                                | Running on MariaDB 11.8 and 12.3, and every place it behaves differently from MySQL                                                   |
| [Repeated keys on MariaDB](./mariadb-repeated-keys.md) | What each read takes from an object that names one key twice, on MariaDB and MySQL                                                    |
| [MariaDB performance](./mariadb-performance.md)        | How fast MariaDB reads nested fields beside MySQL and PostgreSQL, and why                                                             |
| [Behaviour worth knowing](./behaviour.md)              | Things that answer rather than throw, where the answer may surprise you, including where this backend differs from the PostgreSQL one |

If you are choosing between the SQL backends, read [Behaviour worth knowing](./behaviour.md). It records where this backend and `@antelopejs/postgres` disagree.
