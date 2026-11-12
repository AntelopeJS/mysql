/**
 * The client database the external suite reads: created by its owner before the module constructs,
 * and never by the adapter. An external schema id names a database, so the client's tables live in
 * a database of their own. Every value is derived from the row number, so a test can state its
 * expected answer as a native query over the same rows.
 */
export const CLIENT_DATABASE = "sales";

export const CLIENT_USER = "dms_client";

export const READER_PASSWORD = "reader";

/** Rows of the table above the sampling threshold, which the server's statistics only estimate. */
export const BIG_EVENTS_ROWS = 1_100_000;

/** The row numbers `1..n`, which every generated table derives its values from. */
function Series(n: number): string {
  return `WITH RECURSIVE seq (g) AS (SELECT 1 UNION ALL SELECT g + 1 FROM seq WHERE g < ${n})`;
}

/** A UUID-shaped text derived from a seed; MySQL 9 has no `MD5`, so it is cut from a SHA-256. */
function Uuid(seed: string): string {
  return `INSERT(INSERT(INSERT(INSERT(LEFT(SHA2(${seed}, 256), 32), 9, 0, '-'), 14, 0, '-'), 19, 0, '-'), 24, 0, '-')`;
}

const ACCOUNTS = `CREATE TABLE sales.accounts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(200) NOT NULL COMMENT 'Display name',
    email VARCHAR(200),
    status ENUM('lead', 'active', 'churned') NOT NULL DEFAULT 'lead',
    revenue DECIMAL(12,2),
    score INT,
    rating FLOAT,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    signed_on DATE,
    last_seen DATETIME,
    external_ref CHAR(36) UNIQUE,
    tags JSON,
    meta JSON,
    active BOOLEAN,
    big_counter BIGINT,
    name_upper VARCHAR(200) GENERATED ALWAYS AS (UPPER(name)) STORED,
    INDEX accounts_score (score),
    INDEX accounts_revenue (revenue),
    INDEX accounts_created (created_at),
    INDEX accounts_signed (signed_on),
    INDEX accounts_last_seen (last_seen),
    INDEX accounts_status (status),
    INDEX accounts_name (name),
    INDEX accounts_email (email)
  ) COMMENT = 'Customer accounts'`;

const ACCOUNT_ROWS = `INSERT INTO sales.accounts (name, email, status, revenue, score, rating, created_at, signed_on,
      last_seen, external_ref, tags, meta, active, big_counter)
    ${Series(20000)}
    SELECT CONCAT('Acct ', g), CONCAT('User', g, '@Example.com'), ELT(1 + g % 3, 'lead', 'active', 'churned'),
      ROUND(g * 13.37, 2), g % 100, (g % 50) / 10.0, TIMESTAMPADD(HOUR, g, '2026-01-01 00:00:00'),
      DATE_ADD('2026-01-01', INTERVAL g % 300 DAY), TIMESTAMPADD(MINUTE, g, '2026-01-01 00:00:00'),
      ${Uuid("CONCAT('account', g)")}, JSON_ARRAY(CONCAT('t', g % 5)), JSON_OBJECT('k', g), g % 2 = 0,
      9007199254740993 + g
    FROM seq`;

const READ_TABLES: readonly string[] = [
  ACCOUNTS,
  `CREATE TABLE sales.contacts (
    contact_id CHAR(36) PRIMARY KEY,
    account_id BIGINT,
    first_name TEXT NOT NULL,
    created_at DATETIME NOT NULL,
    INDEX contacts_account (account_id),
    INDEX contacts_created (created_at),
    CONSTRAINT contacts_account_id_fkey FOREIGN KEY (account_id) REFERENCES sales.accounts (id)
  )`,
  `CREATE TABLE sales.order_lines (
    order_id INT NOT NULL, line_no INT NOT NULL, sku TEXT, qty INT,
    PRIMARY KEY (order_id, line_no)
  )`,
  `CREATE TABLE sales.events (
    event_ref CHAR(36) NOT NULL, at TIMESTAMP(6) NOT NULL, msg VARCHAR(100),
    UNIQUE KEY events_ref (event_ref), UNIQUE KEY events_at_msg (at, msg)
  )`,
  "CREATE TABLE sales.raw_log (at TIMESTAMP(6) NULL, msg TEXT)",
  "CREATE TABLE sales.countries (code CHAR(2) PRIMARY KEY, name TEXT)",
  "CREATE TABLE sales.flags (id INT PRIMARY KEY, ref CHAR(36), n INT)",
  `INSERT INTO sales.flags VALUES (1, ${Uuid("'flag1'")}, 5), (2, NULL, NULL)`,
  "CREATE TABLE sales.tags (id INT PRIMARY KEY, label TEXT) PARTITION BY HASH (id) PARTITIONS 2",
  ACCOUNT_ROWS,
  `INSERT INTO sales.contacts (contact_id, account_id, first_name, created_at)
    ${Series(20000)}
    SELECT ${Uuid("CONCAT('contact', g)")}, 1 + (g % 20000), CONCAT('First', g),
      TIMESTAMPADD(MINUTE, g, '2026-03-01 23:30:00')
    FROM seq`,
  `INSERT INTO sales.order_lines ${Series(5000)} SELECT g DIV 10, g % 10, CONCAT('sku', g), g % 7 FROM seq`,
  `INSERT INTO sales.events ${Series(5000)}
    SELECT ${Uuid("CONCAT('event', g)")}, TIMESTAMPADD(MINUTE, g, '2026-01-01 00:00:00'), CONCAT('m', g) FROM seq`,
  `INSERT INTO sales.raw_log ${Series(5000)}
    SELECT TIMESTAMPADD(SECOND, g, '2026-01-01 00:00:00'), CONCAT('r', g) FROM seq`,
  "INSERT INTO sales.countries VALUES ('FR', 'France'), ('IT', 'Italy')",
  `INSERT INTO sales.tags ${Series(1000)} SELECT g, CONCAT('tag', g) FROM seq`,
  `CREATE VIEW sales.big_accounts AS
    SELECT a.id, a.name AS account_name, a.revenue FROM sales.accounts a WHERE a.revenue > 1000`,
  `CREATE VIEW sales.daily_signups AS
    SELECT signed_on AS day, COUNT(*) AS n FROM sales.accounts GROUP BY signed_on`,
  "CREATE TABLE sales.people (id INT PRIMARY KEY, name TEXT, ssn TEXT)",
  `INSERT INTO sales.people ${Series(100)} SELECT g, CONCAT('Person ', g), LPAD(g, 9, '0') FROM seq`,
  "CREATE TABLE sales.attachments (id INT PRIMARY KEY, note TEXT, body BLOB)",
  `INSERT INTO sales.attachments VALUES
    (1, REPEAT('n', 300), UNHEX('00010203')),
    (2, 'short', NULL),
    (3, NULL, UNHEX('ff'))`,
  `CREATE TABLE sales.invoices (
    id INT PRIMARY KEY, kind VARCHAR(20) NOT NULL, account_ref BIGINT, broken_ref BIGINT, issued_on DATE
  )`,
  `INSERT INTO sales.invoices ${Series(1000)}
    SELECT g, CASE WHEN g <= 2 THEN 'disputed' ELSE ELT(1 + g % 3, 'paid', 'open', 'void') END,
      1 + (g % 20000), CASE WHEN g % 4 = 0 THEN 900000 + g ELSE 1 + g END,
      DATE_ADD('2025-01-01', INTERVAL g % 400 DAY)
    FROM seq`,
  `CREATE TABLE sales.big_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, kind VARCHAR(10) NOT NULL, at TIMESTAMP(6) NOT NULL
  )`,
  `INSERT INTO sales.big_events (kind, at) ${Series(BIG_EVENTS_ROWS)}
    SELECT ELT(1 + g % 3, 'click', 'view', 'buy'), TIMESTAMPADD(SECOND, g, '2025-01-01 00:00:00') FROM seq`,
];

const WRITE_TABLES: readonly string[] = [
  `CREATE TABLE sales.w_accounts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(5) NOT NULL,
    email VARCHAR(200),
    status ENUM('lead', 'active', 'churned') NOT NULL DEFAULT 'lead',
    revenue DECIMAL(12,2),
    big BIGINT,
    rating FLOAT,
    seen DATETIME(6),
    at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    raw JSON,
    tags JSON,
    perms SET('r', 'w'),
    upper_code VARCHAR(5) GENERATED ALWAYS AS (UPPER(code)) STORED,
    UNIQUE KEY w_accounts_code_key (code),
    CONSTRAINT w_accounts_revenue_check CHECK (revenue >= 0)
  )`,
  `CREATE TABLE sales.w_items (
    sku CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    account_id BIGINT,
    qty INT NOT NULL,
    CONSTRAINT w_items_account_id_fkey FOREIGN KEY (account_id) REFERENCES sales.w_accounts (id)
  )`,
  "CREATE TABLE sales.w_serial (id INT AUTO_INCREMENT PRIMARY KEY, label TEXT)",
  "CREATE TABLE sales.w_events (at TIMESTAMP(6) PRIMARY KEY, msg TEXT)",
  "CREATE TABLE sales.w_big (id BIGINT PRIMARY KEY, label TEXT)",
  `CREATE TABLE sales.w_lines (
    order_id INT NOT NULL, line_no INT NOT NULL, qty INT, PRIMARY KEY (order_id, line_no)
  )`,
  `CREATE TABLE sales.w_pairs (
    a VARCHAR(20) NOT NULL, b INT NOT NULL, v INT, PRIMARY KEY (a, b)
  )`,
  `CREATE TABLE sales.w_bin_pairs (
    a VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, b INT NOT NULL, v INT,
    PRIMARY KEY (a, b)
  )`,
  `CREATE TABLE sales.w_names (
    id INT PRIMARY KEY,
    name VARCHAR(20) COLLATE utf8mb4_0900_ai_ci,
    padded VARCHAR(20) COLLATE utf8mb4_bin,
    legacy VARCHAR(20) CHARACTER SET latin1,
    narrow VARCHAR(20) CHARACTER SET utf8mb3,
    color ENUM('Red', 'Green'),
    shade ENUM('Réd', 'ID', 'Ab'),
    INDEX w_names_legacy (legacy),
    INDEX w_names_narrow (narrow)
  )`,
  "CREATE TABLE sales.w_codes (code VARCHAR(10) CHARACTER SET latin1 PRIMARY KEY, label TEXT)",
];

/**
 * Dates a server without `NO_ZERO_DATE` stored, which strict sessions refuse to write: a zero date,
 * one with a zero month and one with a zero day, each stored between real ones, and NULL.
 */
const ZERO_DATES: readonly string[] = [
  "CREATE TABLE sales.zero_days (id INT PRIMARY KEY, d DATE, dt DATETIME, INDEX zero_days_d (d), INDEX zero_days_dt (dt))",
  "SET SESSION sql_mode = ''",
  `INSERT INTO sales.zero_days VALUES
    (1, '0000-00-00', '0000-00-00 00:00:00'),
    (2, '2024-01-01', '2024-01-01 10:00:00'),
    (3, '2024-00-15', '2024-00-15 00:00:00'),
    (4, NULL, NULL),
    (5, '2024-05-00', '2024-05-00 00:00:00'),
    (6, '2023-12-31', '2023-12-31 23:00:00')`,
  "SET SESSION sql_mode = DEFAULT",
];

/** The relations the reader may read whole; `people` it reads only in part. */
const READABLE: readonly string[] = [
  "accounts",
  "contacts",
  "order_lines",
  "events",
  "raw_log",
  "countries",
  "flags",
  "tags",
  "big_accounts",
  "daily_signups",
  "attachments",
  "invoices",
  "big_events",
  "w_accounts",
  "w_items",
  "w_serial",
  "w_events",
  "w_big",
  "w_lines",
  "w_pairs",
  "w_bin_pairs",
  "w_names",
  "w_codes",
  "zero_days",
];

const VIEWS: readonly string[] = ["big_accounts", "daily_signups"];

export const FIXTURE: readonly string[] = [
  "SET SESSION cte_max_recursion_depth = 2000000",
  ...READ_TABLES,
  ...WRITE_TABLES,
  ...ZERO_DATES,
  `ANALYZE TABLE ${READABLE.filter((name) => !VIEWS.includes(name))
    .map((name) => `sales.${name}`)
    .join(", ")}`,
];

/** The tables the external suite writes; every other relation stays readable only. */
const WRITABLE_TABLES: readonly string[] = READABLE.filter((name) =>
  name.startsWith("w_"),
);

/** What a client grants the account the DMS writes with: rows of the writable tables. */
export function WriterGrants(user: string): string[] {
  return WRITABLE_TABLES.map(
    (table) =>
      `GRANT INSERT, UPDATE, DELETE ON sales.${table} TO '${user}'@'%'`,
  );
}

/**
 * What a client grants the account the DMS reads with: each relation's rows, a view's definition
 * so the optimizer may estimate it, and only some of `people`'s columns.
 */
export function ReaderGrants(user: string): string[] {
  return [
    ...READABLE.map(
      (relation) => `GRANT SELECT ON sales.${relation} TO '${user}'@'%'`,
    ),
    ...VIEWS.map((view) => `GRANT SHOW VIEW ON sales.${view} TO '${user}'@'%'`),
    `GRANT SELECT (id, name) ON sales.people TO '${user}'@'%'`,
  ];
}
