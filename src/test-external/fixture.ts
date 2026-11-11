/**
 * The client database the external suite reads: created by its owner before the module constructs,
 * and never by the adapter. An external schema id names a database, so the client's tables live in
 * a database of their own.
 */
export const CLIENT_DATABASE = "sales";

export const CLIENT_USER = "dms_client";

export const READER_PASSWORD = "reader";

export const FIXTURE: readonly string[] = [
  `CREATE TABLE sales.accounts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(200) NOT NULL
  )`,
  "INSERT INTO sales.accounts (name) VALUES ('Acct 1'), ('Acct 2')",
  `CREATE TABLE sales.w_accounts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(5) NOT NULL UNIQUE
  )`,
];

/** The tables the external suite writes; every other relation stays readable only. */
const WRITABLE_TABLES: readonly string[] = ["sales.w_accounts"];

/** What a client grants the account the DMS writes with: rows of the writable tables. */
export function WriterGrants(user: string): string[] {
  return WRITABLE_TABLES.map(
    (table) => `GRANT INSERT, UPDATE, DELETE ON ${table} TO '${user}'@'%'`,
  );
}

/** What a client grants the account the DMS reads with: the database's rows, nothing more. */
export function ReaderGrants(user: string): string[] {
  return [`GRANT SELECT ON ${CLIENT_DATABASE}.* TO '${user}'@'%'`];
}
