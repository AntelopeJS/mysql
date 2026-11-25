# Changelog

## v0.2.9

[compare changes](https://github.com/AntelopeJS/mysql/compare/v0.2.8...v0.2.9)

### 🩹 Fixes

- **update:** Switch the update stage on options.by ([#133](https://github.com/AntelopeJS/mysql/pull/133))
- **update:** Narrow update stages with UpdatesByFunction ([#138](https://github.com/AntelopeJS/mysql/pull/138))
- **deps:** Depend on the stable @antelopejs/interface-database

### 📖 Documentation

- **skills:** Name only tools this repo has in the formal skills ([#130](https://github.com/AntelopeJS/mysql/pull/130))

### 🏡 Chore

- **deps:** Update dependency @antelopejs/api to v1.7.8 ([#132](https://github.com/AntelopeJS/mysql/pull/132))
- **deps:** Update dependency oxlint-tsgolint to v7.0.2008 ([#135](https://github.com/AntelopeJS/mysql/pull/135))
- **deps:** Update dependency @testcontainers/mysql to v12.2.2 ([#134](https://github.com/AntelopeJS/mysql/pull/134))
- **deps:** Update dependency fast-check to v4.11.0 ([#140](https://github.com/AntelopeJS/mysql/pull/140))
- **deps:** Update dependency knip to v6.47.0 ([#141](https://github.com/AntelopeJS/mysql/pull/141))
- **deps:** Update pnpm to v10.34.9 ([#142](https://github.com/AntelopeJS/mysql/pull/142))

### 🤖 CI

- Re-sync the AntelopeJS pack for the release app ([#128](https://github.com/AntelopeJS/mysql/pull/128))
- Stop forwarding the retired RELEASE_GITHUB_TOKEN ([#129](https://github.com/AntelopeJS/mysql/pull/129))

### ❤️ Contributors

- Antony Rizzitelli

## v0.2.8

[compare changes](https://github.com/AntelopeJS/mysql/compare/v0.2.7...v0.2.8)

### 🩹 Fixes

- **ci:** Run the formal checks on Windows and size test bounds for a loaded host ([#126](https://github.com/AntelopeJS/mysql/pull/126))
- **deps:** Depend on the stable @antelopejs/interface-database-catalog

### 📖 Documentation

- **external-mode:** Name the current catalog consumers ([#124](https://github.com/AntelopeJS/mysql/pull/124))

### 📦 Build

- **ci:** Roll out trunk CI and merge queue ([#123](https://github.com/AntelopeJS/mysql/pull/123))

### ✅ Tests

- **catalog:** Run the shared fewer-than-5 profile check ([#125](https://github.com/AntelopeJS/mysql/pull/125))

### ❤️ Contributors

- Antony Rizzitelli

## v0.2.7

[compare changes](https://github.com/AntelopeJS/mysql/compare/v0.2.6...v0.2.7)

### 🩹 Fixes

- **database:** Answer false for match on a value that is not text ([#121](https://github.com/AntelopeJS/mysql/pull/121))

### ✅ Tests

- **mysql:** Cover the key read in queries nested in a group the outer row filters ([#119](https://github.com/AntelopeJS/mysql/pull/119))

### ❤️ Contributors

- Antony Rizzitelli

## v0.2.6

[compare changes](https://github.com/AntelopeJS/mysql/compare/v0.2.5...v0.2.6)

### 🩹 Fixes

- **mysql:** Answer each group's own rows where its mapper reads the key, stream or outer row ([#116](https://github.com/AntelopeJS/mysql/pull/116))
- **mysql:** Refuse on MariaDB only a group's stream read in a map's callback over an array ([#117](https://github.com/AntelopeJS/mysql/pull/117))

### 📖 Documentation

- Drop the cancelled #105 and #111 from the 0.2.5 changelog ([#115](https://github.com/AntelopeJS/mysql/pull/115))

### ❤️ Contributors

- Antony Rizzitelli

## v0.2.5

[compare changes](https://github.com/AntelopeJS/mysql/compare/v0.2.4...v0.2.5)

### 🩹 Fixes

- **probe:** Count the right to create tables as write access ([#104](https://github.com/AntelopeJS/mysql/pull/104))
- **catalog:** End an enum or integer range at values counted 5 times ([#114](https://github.com/AntelopeJS/mysql/pull/114))

### 📖 Documentation

- **agents:** Describe the repo, its layout and how to test ([#103](https://github.com/AntelopeJS/mysql/pull/103))
- **formal:** Describe nested group reads as next answers them after #111 ([#113](https://github.com/AntelopeJS/mysql/pull/113))

### 📦 Build

- Move to @antelopejs/tooling-configs 0.8 and the three-tier CI ([#101](https://github.com/AntelopeJS/mysql/pull/101))

### ✅ Tests

- Add formal targets for JSON value identity and merge on repeated keys ([#107](https://github.com/AntelopeJS/mysql/pull/107))
- **verify:** Cover the probe and the unmapped files in the verification skill ([#108](https://github.com/AntelopeJS/mysql/pull/108))
- **mariadb:** Add formal targets for cut-value reads and the unique-index gate ([#106](https://github.com/AntelopeJS/mysql/pull/106))
- **formal:** Add a formal target for stage chains and a journey for catalog roles ([#109](https://github.com/AntelopeJS/mysql/pull/109))

### 🤖 CI

- **release:** Publish without re-running the test matrix ([#100](https://github.com/AntelopeJS/mysql/pull/100))


### ❤️ Contributors

- Antony Rizzitelli

## v0.2.4

[compare changes](https://github.com/AntelopeJS/mysql/compare/v0.2.3...v0.2.4)

### 🚀 Enhancements

- **mysql:** Hand over a cursor's rows in batches ([#98](https://github.com/AntelopeJS/mysql/pull/98))

### 🩹 Fixes

- **catalog:** Fold rare category values inside the query ([#99](https://github.com/AntelopeJS/mysql/pull/99))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.2.3

[compare changes](https://github.com/AntelopeJS/mysql/compare/v0.2.2...v0.2.3)

### 🚀 Enhancements

- **probe:** Export the connection probe the DMS connect flow calls ([#97](https://github.com/AntelopeJS/mysql/pull/97))

### 🩹 Fixes

- **mariadb:** Read a JSON number past the doubles as the greatest double without a cast ([#96](https://github.com/AntelopeJS/mysql/pull/96))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.2.2

[compare changes](https://github.com/AntelopeJS/mysql/compare/v0.2.1...v0.2.2)

### 🔥 Performance

- **mariadb:** Respell a dedup key's numbers over its bytes, in linear time ([#77](https://github.com/AntelopeJS/mysql/pull/77))

### 🩹 Fixes

- **feeds:** Deliver the new document of an update that leaves a filter before two maps ([#78](https://github.com/AntelopeJS/mysql/pull/78))
- **mysql:** Dedup a group's collected values by the engine's own comparison ([#80](https://github.com/AntelopeJS/mysql/pull/80))
- **mariadb:** Fail a cursor whose walk was cut or nested too deep instead of reading it ([#79](https://github.com/AntelopeJS/mysql/pull/79))
- **mariadb:** Refuse an 11.8 merge of a deep operand that repeats a key, through reads, cursors and writes ([#84](https://github.com/AntelopeJS/mysql/pull/84))
- **mariadb:** Compare two JSON numbers in eq as MySQL's JSON = does ([#81](https://github.com/AntelopeJS/mysql/pull/81))
- **mysql:** Grow the sort buffer only for a statement that runs out of it ([#82](https://github.com/AntelopeJS/mysql/pull/82))
- **mysql:** Name binlog_format when a statement-format binary log refuses a write ([#85](https://github.com/AntelopeJS/mysql/pull/85))
- **mariadb:** Dedup an object holding a number spelled with an exponent as one value ([#83](https://github.com/AntelopeJS/mysql/pull/83))
- **mariadb:** Fail a cursor before it hands over a row read wrong ([#87](https://github.com/AntelopeJS/mysql/pull/87))
- **mysql:** Read a group's rows again where a nested query's row is read by its stream ([#86](https://github.com/AntelopeJS/mysql/pull/86))
- **mysql:** Log no failed connection for a cursor closed before its first read ([#92](https://github.com/AntelopeJS/mysql/pull/92))
- **mariadb:** List every warning a read raises, up to 65,535 ([#91](https://github.com/AntelopeJS/mysql/pull/91))
- **mariadb:** Compare a nested JSON number by its value as MySQL reads it ([#89](https://github.com/AntelopeJS/mysql/pull/89))
- **mariadb:** Tolerate a cursor's warnings only within one snapshot ([#90](https://github.com/AntelopeJS/mysql/pull/90))

### 📖 Documentation

- **mysql:** List the group callback shapes that answer wrong rows or fail ([#95](https://github.com/AntelopeJS/mysql/pull/95))

### ✅ Tests

- **mysql:** Pin that a change feed on a statement-format binary log names binlog_format ([#88](https://github.com/AntelopeJS/mysql/pull/88))
- **mysql:** Hold a group's distinct to twice the top-level budget, and pin a 0 and -0 key's distinct ([#94](https://github.com/AntelopeJS/mysql/pull/94))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.2.1

[compare changes](https://github.com/AntelopeJS/mysql/compare/v0.2.0...v0.2.1)

### 🔥 Performance

- **default:** Hold a key read of a computed value once so a chain of defaults reads each link once ([#63](https://github.com/AntelopeJS/mysql/pull/63))
- **stage:** Hold a computed read once past a fixed member or a string operation ([#65](https://github.com/AntelopeJS/mysql/pull/65))

### 🩹 Fixes

- **mariadb:** Pin group_concat_max_len at its 1 GiB ceiling so a strict session accepts it ([#58](https://github.com/AntelopeJS/mysql/pull/58))
- **dialect:** Keep the last member of a key named twice where a merge rebuilds an object on MariaDB ([#57](https://github.com/AntelopeJS/mysql/pull/57))
- **dialect:** Hold a walk's source in a derived table on MySQL ([#60](https://github.com/AntelopeJS/mysql/pull/60))
- **group:** Hand the mapper 0 for a -0 in a key of declared numbers ([#64](https://github.com/AntelopeJS/mysql/pull/64))
- **dialect:** Dedup a JSON number past 2^63 on MariaDB and a decimal of another scale on MySQL as one value ([#62](https://github.com/AntelopeJS/mysql/pull/62))
- **mariadb:** Fail a plain read whose document nests past 31 containers, as MySQL does ([#66](https://github.com/AntelopeJS/mysql/pull/66))
- **config:** Refuse a statementTimeoutMs above MariaDB's one-year max_statement_time cap ([#67](https://github.com/AntelopeJS/mysql/pull/67))
- **dialect:** Dedup a number nested in an array or object by its value, not its spelling ([#59](https://github.com/AntelopeJS/mysql/pull/59))
- **dialect:** Keep an escaped key's value where a merge operand nests 31 deep on MariaDB ([#69](https://github.com/AntelopeJS/mysql/pull/69))
- **dialect:** Cast a walk's held source on MySQL so 8.4 resolves it beside a bare read of the same column ([#68](https://github.com/AntelopeJS/mysql/pull/68))
- **mariadb:** Clear a too-deep read's warning so the next table-less read on its connection answers ([#71](https://github.com/AntelopeJS/mysql/pull/71))
- **dialect:** Dedup an integer from 2^63 to 2^64 - 1 spelled as a double as one value ([#72](https://github.com/AntelopeJS/mysql/pull/72))
- **mariadb:** Fail a read whose aggregate passed max_allowed_packet instead of reading it cut ([#73](https://github.com/AntelopeJS/mysql/pull/73))
- **mariadb:** Dedup a nested number spelled with an exponent as one value ([#74](https://github.com/AntelopeJS/mysql/pull/74))
- **mariadb:** Deliver a change feed whose second map merges the row the first one merged ([#75](https://github.com/AntelopeJS/mysql/pull/75))
- **dialect:** Keep the last member where a merge operand spells a key twice 32 deep on MariaDB 12.3 ([#76](https://github.com/AntelopeJS/mysql/pull/76))

### 📖 Documentation

- Name pinned server images instead of versions in prose ([#70](https://github.com/AntelopeJS/mysql/pull/70))

### ✅ Tests

- **group:** Group [0] and [-0], and {a: 0} and {a: -0}, as one key on every server ([#61](https://github.com/AntelopeJS/mysql/pull/61))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.2.0

[compare changes](https://github.com/AntelopeJS/mysql/compare/v0.1.2...v0.2.0)

### 🚀 Enhancements

- **deps:** ⚠️  Require interface-database 0.4 ([#33](https://github.com/AntelopeJS/mysql/pull/33))

### 🔥 Performance

- **join:** Treat a filter on `_id` as a one-row left side of a MariaDB JSON-key join ([#36](https://github.com/AntelopeJS/mysql/pull/36))
- **default:** Hold a computed value once so a chain of defaults reads each link once ([#48](https://github.com/AntelopeJS/mysql/pull/48))
- **stage:** Read a key computed from a computed key through one held value ([#50](https://github.com/AntelopeJS/mysql/pull/50))

### 🩹 Fixes

- **formal:** Load the change-feed check's output as CommonJS whatever package.json sits above TMPDIR ([#37](https://github.com/AntelopeJS/mysql/pull/37))
- **dialect:** Dedup 0 and -0 as one value at the top and in a group on both engines ([#39](https://github.com/AntelopeJS/mysql/pull/39))
- **dialect:** Group 0 and -0 as one key on MariaDB and in a compound key on MySQL ([#51](https://github.com/AntelopeJS/mysql/pull/51))
- **feeds:** End a MariaDB 11.8 feed at a projection nested past its limit, and deliver a hollow field 29 levels deep ([#41](https://github.com/AntelopeJS/mysql/pull/41))
- **json:** Read a MariaDB member under a computed key a JSON writer escapes ([#42](https://github.com/AntelopeJS/mysql/pull/42))
- **catalog:** Count privileges granted through a role, and an account name holding @ ([#43](https://github.com/AntelopeJS/mysql/pull/43))
- **dialect:** Read a constant slice of a table's rows on MariaDB without aggregating them whole past max_allowed_packet ([#45](https://github.com/AntelopeJS/mysql/pull/45))
- **bench:** Check every nested field in the run output and record guards ([#47](https://github.com/AntelopeJS/mysql/pull/47))
- **dialect:** Dedup 0 and -0 nested in an array or an object as one value ([#53](https://github.com/AntelopeJS/mysql/pull/53))
- **feeds:** Deliver a MariaDB 11.8 merge map's 31-container document ([#52](https://github.com/AntelopeJS/mysql/pull/52))
- **dialect:** Dedup the spellings of a top-level JSON number as one value on both engines ([#54](https://github.com/AntelopeJS/mysql/pull/54))
- **mariadb:** Sort texts that share their first 2,048 bytes apart, a slice's included ([#56](https://github.com/AntelopeJS/mysql/pull/56))

### 📖 Documentation

- Name the time zone tables a named zone needs, and the null it reads without them ([#44](https://github.com/AntelopeJS/mysql/pull/44))
- **mariadb:** State what each read takes from an object that names one key twice ([#49](https://github.com/AntelopeJS/mysql/pull/49))

### 📦 Build

- **deps:** ⚠️  Cap every @antelopejs range below its next minor on tooling-configs 0.7 ([#55](https://github.com/AntelopeJS/mysql/pull/55))

### ✅ Tests

- **dialect:** Map and filter a nested distinct() that reads its outer row on MariaDB ([#35](https://github.com/AntelopeJS/mysql/pull/35))
- Send off-contract values from plain-JS untyped specs instead of WithForeign ([#38](https://github.com/AntelopeJS/mysql/pull/38))
- **verify:** Build every compared journey array with GROUP_CONCAT ORDER BY ([#46](https://github.com/AntelopeJS/mysql/pull/46))
- **verify:** Read the session pin on MariaDB from its statement history ([#40](https://github.com/AntelopeJS/mysql/pull/40))

### 🤖 CI

- Run checks and tests on Windows against the runner's MySQL 8.4 ([#34](https://github.com/AntelopeJS/mysql/pull/34))

#### ⚠️ Breaking Changes

- **deps:** ⚠️  Require interface-database 0.4 ([#33](https://github.com/AntelopeJS/mysql/pull/33))
- **deps:** ⚠️  Cap every @antelopejs range below its next minor on tooling-configs 0.7 ([#55](https://github.com/AntelopeJS/mysql/pull/55))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.1.2

[compare changes](https://github.com/AntelopeJS/mysql/compare/v0.1.1...v0.1.2)

### 🔥 Performance

- **dialect:** Look up an unindexed join on JSON-compared keys by a hash of each row's key on MariaDB ([#32](https://github.com/AntelopeJS/mysql/pull/32))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.1.1

[compare changes](https://github.com/AntelopeJS/mysql/compare/v0.1.0...v0.1.1)

### 🔥 Performance

- **dialect:** Share MariaDB's keyed group lookup across a map's outer rows, and read unindexed groups by primary key ([#31](https://github.com/AntelopeJS/mysql/pull/31))
- **filter:** Test a JSON read's JSON_VALUE text before its typed comparison ([#11](https://github.com/AntelopeJS/mysql/pull/11))

### 🩹 Fixes

- **query:** Keep a relation's order when a later stage wraps it in a derived table ([#16](https://github.com/AntelopeJS/mysql/pull/16))
- **dialect:** Keep a stored "null" string through eq(null) and array add on MariaDB ([#26](https://github.com/AntelopeJS/mysql/pull/26))
- **indexes:** Refuse the writes a unique index the server refused would check ([#25](https://github.com/AntelopeJS/mysql/pull/25))
- **connection:** Name the engine in the pool, startup, slow-acquire and not-connected messages ([#27](https://github.com/AntelopeJS/mysql/pull/27))
- **dialect:** Answer MariaDB's nested groups, unions, joins and stages after a group or computed slice that read their outer row ([#9](https://github.com/AntelopeJS/mysql/pull/9))
- **lookup:** Collect a looked-up list in the order its query asks for ([#28](https://github.com/AntelopeJS/mysql/pull/28))
- **indexes:** Refuse the writes a unique index a lock holds off would check, and build it once the lock is gone ([#29](https://github.com/AntelopeJS/mysql/pull/29))

### ✅ Tests

- Count and take nth of a nested join whose condition reads its outer row on MariaDB ([#12](https://github.com/AntelopeJS/mysql/pull/12))
- **decorators:** Serve each run's api on its own port instead of locking 5010 ([#30](https://github.com/AntelopeJS/mysql/pull/30))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

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

