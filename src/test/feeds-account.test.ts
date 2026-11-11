import { expect } from "chai";
import { createConnection } from "mysql2/promise";
import { randomBytes } from "node:crypto";
import { Schema } from "@antelopejs/interface-database/schema";

import { GetOptions, type Options } from "../config";
import {
  Schemas,
  SettleRegistrations,
} from "../implementations/database/schema";
import { Reconnect } from "./tables";
import { DeliveredRow, Opened, type Row } from "./watch";

const PRIVILEGES =
  "CREATE, ALTER, INDEX, TRIGGER, LOCK TABLES, SELECT, INSERT, UPDATE, DELETE";

const PASSWORD = "application-account";

const NARROW = {
  items: { fields: { name: "string" }, indexes: {} },
} as const;

const WIDE = {
  items: { fields: { name: "string", size: "number" }, indexes: {} },
} as const;

type Tables = { items: Row };

const SERVER_REFUSAL = 1419;

const SCHEMA_IDS = ["account-open", "account-swap", "account-super"];

/** What a refusal says: the cause, both remedies and where MySQL documents the rule. */
const REFUSAL_PARTS = [
  "change feed",
  "binary logging",
  "GRANT SUPER ON *.*",
  "SET GLOBAL log_bin_trust_function_creators = 1",
  "stored-programs-logging.html",
];

function Missing(err: Error): string[] {
  return REFUSAL_PARTS.filter((part) => !err.message.includes(part));
}

/** The error the server answered, which a refusal keeps as the end of its `cause` chain. */
function ServerError(err: Error): Error {
  return err.cause instanceof Error ? ServerError(err.cause) : err;
}

async function Rejection(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending;
  } catch (err) {
    if (err instanceof Error) {
      return err;
    }
    throw err;
  }
  return expect.fail("the account has no way to create a trigger");
}

describe("change feeds for an application account", function () {
  this.timeout(60_000);
  const user = `app_${randomBytes(4).toString("hex")}`;
  let admin: Options;
  let database: string;

  async function AsAdmin(statements: readonly string[]): Promise<void> {
    const connection = await createConnection(admin.url ?? "");
    try {
      for (const statement of statements) {
        await connection.query(statement);
      }
    } finally {
      await connection.end();
    }
  }

  function AccountUrl(): string {
    const target = new URL(admin.url ?? "");
    target.username = user;
    target.password = PASSWORD;
    return target.toString();
  }

  before(async () => {
    await SettleRegistrations();
    admin = GetOptions();
    database = decodeURIComponent(new URL(admin.url ?? "").pathname.slice(1));
    await AsAdmin([
      `CREATE USER '${user}'@'%' IDENTIFIED BY '${PASSWORD}'`,
      `GRANT ${PRIVILEGES} ON \`${database}\`.* TO '${user}'@'%'`,
    ]);
  });

  afterEach(async () => {
    await Reconnect(admin);
  });

  after(async () => {
    SCHEMA_IDS.forEach((schemaId) => Schemas.unregister(schemaId));
    await AsAdmin([`DROP USER IF EXISTS '${user}'@'%'`]);
  });

  it("opens a feed, or says that MySQL's binary logging wants SUPER or log_bin_trust_function_creators", async () => {
    await Reconnect({ ...admin, url: AccountUrl() });
    const schema = new Schema<Tables>(SCHEMA_IDS[0], NARROW);
    const items = schema.instance().table("items");
    const err = await Rejection(Opened(items, "probe"));
    expect(Missing(err)).to.deep.equal([]);
    expect(ServerError(err)).to.have.property("errno", SERVER_REFUSAL);
  });

  it("converges a watched table's triggers, or says the same when the account may not swap them", async () => {
    const before = new Schema<Tables>(SCHEMA_IDS[1], NARROW);
    const feed = await Opened(before.instance().table("items"), "seed");
    await feed.return?.();
    await Reconnect({ ...admin, url: AccountUrl() });
    const after = new Schema<Tables>(SCHEMA_IDS[1], WIDE);
    const err = await Rejection(
      (async () => after.instance().table("items").get("absent"))(),
    );
    expect(Missing(err)).to.deep.equal([]);
    expect(ServerError(err)).to.have.property("errno", SERVER_REFUSAL);
    expect(err.message).to.include("swapTriggers");
  });

  it("opens a feed once the account holds SUPER, which is the first remedy the refusal names", async () => {
    await AsAdmin([`GRANT SUPER ON *.* TO '${user}'@'%'`]);
    await Reconnect({ ...admin, url: AccountUrl() });
    const schema = new Schema<Tables>(SCHEMA_IDS[2], NARROW);
    const items = schema.instance().table("items");
    const feed = await Opened(items, "probe");
    await items.insert({ _id: "after", name: "after" });
    const change = await DeliveredRow(feed, "after");
    await feed.return?.();
    expect(change).to.have.nested.property("newValue.name", "after");
  });
});
