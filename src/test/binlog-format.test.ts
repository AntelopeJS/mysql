import { expect } from "chai";
import {
  type Connection,
  type RowDataPacket,
  createConnection,
} from "mysql2/promise";
import { Schema } from "@antelopejs/interface-database/schema";

import { type Options, GetOptions } from "../config";
import { Reconnect } from "./tables";

const INSTANCE = "one";

/** A row of a global's value, read through the one column it names. */
interface GlobalRow extends RowDataPacket {
  readonly value: string;
}

interface Item {
  _id: string;
  name?: string;
}

const schema = new Schema<{ items: Item }>("binlog-format", {
  items: { fields: { name: "string" }, indexes: {} },
});

const Items = () => schema.instance(INSTANCE).table("items");

async function Refusal(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending;
  } catch (err) {
    if (err instanceof Error) {
      return err;
    }
    throw err;
  }
  return expect.fail("the server was expected to refuse the write");
}

describe("an owned write or change feed where the server logs statements", function () {
  this.timeout(60_000);
  let admin: Connection | undefined;
  let options: Options;
  let saved: string | undefined;

  before(async () => {
    options = GetOptions();
    await schema.createInstance(INSTANCE).run();
    await Items().insert({ _id: "before", name: "before" }).run();
    admin = await createConnection(options.url ?? "");
    const [[row]] = await admin.query<GlobalRow[]>(
      "SELECT @@GLOBAL.binlog_format AS value",
    );
    saved = row.value;
    await admin.query("SET GLOBAL binlog_format = 'STATEMENT'");
    await Reconnect(options);
  });

  after(async () => {
    try {
      if (admin && saved !== undefined) {
        await admin.query("SET GLOBAL binlog_format = ?", [saved]);
        await Reconnect(options);
      }
    } finally {
      await admin?.end();
    }
  });

  /** Fails where the refusal is the server's errno alone, which names no remedy. */
  it("is refused with an error that names binlog_format and the formats it takes", async () => {
    const err = await Refusal(
      Items().get("before").update({ name: "during" }).run(),
    );
    expect({
      setting: err.message.includes("binlog_format"),
      remedy: err.message.includes("ROW or MIXED"),
      errno:
        err.cause instanceof Error && "errno" in err.cause
          ? err.cause.errno
          : undefined,
    }).to.deep.equal({ setting: true, remedy: true, errno: 1665 });
  });

  /** Fails where the feed's numbering of its log fails with the server's errno alone. */
  it("refuses to open a change feed with an error that names binlog_format and the formats it takes", async () => {
    const feed = Items().changes().cursor();
    const err = await Refusal(feed.next());
    await feed.return?.();
    expect({
      setting: err.message.includes("binlog_format"),
      remedy: err.message.includes("ROW or MIXED"),
    }).to.deep.equal({ setting: true, remedy: true });
  });
});
