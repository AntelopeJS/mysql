import type { JourneyContext } from "@antelopejs/tooling-configs/verify";

import { seed, server, urlOf, type ModuleConfig } from "./session.ts";

/** The client's database an external instance reads, created by its owner and never by the module. In external mode the schema id names it. */
export const CLIENT = "sales";

/** The account the external instance connects as: it reads every table and writes `sales.accounts` only. */
export const READER = "verify_reader";

const CLIENT_SCHEMA = `CREATE DATABASE ${CLIENT};
CREATE TABLE ${CLIENT}.accounts (id BIGINT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(20) NOT NULL, status ENUM('lead', 'active', 'churned') NOT NULL DEFAULT 'lead', score INT, label VARCHAR(30) GENERATED ALWAYS AS (CONCAT(name, '!')) VIRTUAL, created_at TIMESTAMP(3) NOT NULL DEFAULT '2026-01-01 00:00:00') COMMENT = 'Customer accounts';
CREATE TABLE ${CLIENT}.audit (id INT PRIMARY KEY, note TEXT);
CREATE VIEW ${CLIENT}.active_accounts AS SELECT name, score FROM ${CLIENT}.accounts WHERE status = 'active';
INSERT INTO ${CLIENT}.accounts (id, name, status, score) WITH RECURSIVE g (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 30) SELECT n, CONCAT('Account ', n), ELT(1 + n % 3, 'lead', 'active', 'churned'), n % 4 FROM g;
INSERT INTO ${CLIENT}.audit VALUES (1, 'kept');
CREATE USER '${READER}'@'%';
GRANT SELECT ON ${CLIENT}.* TO '${READER}'@'%';
GRANT INSERT, UPDATE, DELETE ON ${CLIENT}.accounts TO '${READER}'@'%';
ANALYZE TABLE ${CLIENT}.accounts;`;

/** Creates the client's `sales` database with 30 accounts, and the reader account with its grants, as root. */
export async function seedClient(context: JourneyContext): Promise<void> {
  await seed(context, "create the client's database, rows, account and grants", CLIENT_SCHEMA, "mysql");
}

/** The config of an external instance on the client's database as the reader account, with `extra` merged in. */
export function externalConfig(context: JourneyContext, extra: ModuleConfig = {}): ModuleConfig {
  return { mode: "external", url: urlOf(server(context), READER, CLIENT), ...extra };
}

/** The declaration of the client's `sales` database, verbatim names. */
export const SALES = `new Schema("${CLIENT}", {
  accounts: { fields: { _id: "string", id: "string", name: "string", status: "string", score: "number", label: "string", created_at: "date" }, indexes: {} },
  audit: { fields: { _id: "string", id: "number", note: "string" }, indexes: {} },
  active_accounts: { fields: { name: "string", score: "number" }, indexes: {} },
})`;
