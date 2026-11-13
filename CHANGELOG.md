# Changelog

## v0.1.0


### 🚀 Enhancements

- Add the MySQL backend ([#1](https://github.com/AntelopeJS/mysql/pull/1))
- **dialect:** Serve MariaDB 11.8 and 12.3 beside MySQL ([#2](https://github.com/AntelopeJS/mysql/pull/2))

### 🔥 Performance

- **dialect:** Compute an unindexed join key once per row on MariaDB ([#10](https://github.com/AntelopeJS/mysql/pull/10))

### 🩹 Fixes

- **indexes:** Start a unique-index build the server stops again on the pool ([#23](https://github.com/AntelopeJS/mysql/pull/23))
- **dialect:** Answer MariaDB's nested queries that read their outer row without a derived table ([#4](https://github.com/AntelopeJS/mysql/pull/4))
- **schema:** Register again a schema whose convergence started on a pool since ended ([#20](https://github.com/AntelopeJS/mysql/pull/20))
- **feeds:** Remove the change-feed and nested-write edge limits ([#6](https://github.com/AntelopeJS/mysql/pull/6))
- **dialect:** Escape control characters in JSON path members ([#17](https://github.com/AntelopeJS/mysql/pull/17))
- **dialect:** Keep an absent field apart from a JSON null in a group's distinct() ([#18](https://github.com/AntelopeJS/mysql/pull/18))
- **json:** Read a MariaDB member whose key a JSON writer escapes ([#19](https://github.com/AntelopeJS/mysql/pull/19))
- **schema:** Build the unique indexes on the next pool after a reconnect stops the index phase ([#22](https://github.com/AntelopeJS/mysql/pull/22))
- **dialect:** Keep a stored "null" string through default() on MariaDB ([#21](https://github.com/AntelopeJS/mysql/pull/21))
- **rows:** Number a sliced order in that order before a computed nth ([#7](https://github.com/AntelopeJS/mysql/pull/7))
- **connection:** Name the detected engine in the connect and disconnect log lines ([#13](https://github.com/AntelopeJS/mysql/pull/13))
- **dialect:** Keep an absent field apart from a JSON null in MariaDB's nested distinct() ([#14](https://github.com/AntelopeJS/mysql/pull/14))

### 🏡 Chore

- Prepare the repository for its public release ([#5](https://github.com/AntelopeJS/mysql/pull/5))

### ✅ Tests

- **feeds:** Verify change-feed delivery under every interleaving of writers, sequencer and reaper ([#3](https://github.com/AntelopeJS/mysql/pull/3))
- **cursors:** Seed past the socket buffers and wait on the server's lock state ([#15](https://github.com/AntelopeJS/mysql/pull/15))
- **verify:** Run every journey on MariaDB 11.8 beside MySQL 8.4 ([#8](https://github.com/AntelopeJS/mysql/pull/8))
- **feeds:** Run the row-order race on the server once the sequencer pass scans ([#24](https://github.com/AntelopeJS/mysql/pull/24))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

