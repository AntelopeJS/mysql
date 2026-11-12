import { expect } from "chai";
import type { Schema } from "@antelopejs/interface-database/schema";

import { type Sql, ident, param, sql } from "../statement";
import { NativeWrite, RegisterSales, type SalesTables } from "./sales";

let sales: Schema<SalesTables>;

function Table(tableId: string) {
  return sales.instance().table(tableId);
}

function Rows(table: string): Sql {
  return sql`${ident("sales")}.${ident(table)}`;
}

/** Key parts JSON writes with an escape: a newline, a tab, a NUL, a quote and a backslash. */
const ESCAPED_PARTS = [
  "line\nbreak",
  "tab\there",
  "nul\0char",
  'say "hi"',
  "back\\slash",
];

async function Seed(table: string, parts: readonly string[]): Promise<void> {
  await NativeWrite(sql`DELETE FROM ${Rows(table)}`);
  for (const [at, part] of parts.entries()) {
    await NativeWrite(
      sql`INSERT INTO ${Rows(table)} (a, b, v) VALUES (${param(part)}, 1, ${param(at)})`,
    );
  }
}

describe("a composite key whose text part JSON escapes", function () {
  this.timeout(60_000);

  before(async () => {
    sales = await RegisterSales();
    await Seed("w_pairs", ESCAPED_PARTS);
  });

  it("finds each row again by the _id a read answers for it", async () => {
    const rows = await Table("w_pairs").run();
    expect(rows.map((row) => row.a)).to.have.members(ESCAPED_PARTS);
    for (const row of rows) {
      const again = await Table("w_pairs").get(String(row._id)).run();
      expect(again?.a, String(row._id)).to.equal(row.a);
    }
  });

  it("updates and deletes each row by that _id", async () => {
    for (const row of await Table("w_pairs").run()) {
      const id = String(row._id);
      expect(
        await Table("w_pairs").get(id).update({ v: 100 }).run(),
        id,
      ).to.equal(1);
      expect(await Table("w_pairs").get(id).delete().run(), id).to.equal(1);
    }
    expect(await Table("w_pairs").count().run()).to.equal(0);
  });
});

describe("a composite key with a utf8mb4_bin text part", function () {
  this.timeout(60_000);

  const id = JSON.stringify(["x", "1"]);

  beforeEach(async () => {
    sales = await RegisterSales();
    await Seed("w_bin_pairs", ["x"]);
  });

  it("updates and replaces the row by its _id", async () => {
    expect(await Table("w_bin_pairs").get(id).update({ v: 2 }).run()).to.equal(
      1,
    );
    expect(
      await Table("w_bin_pairs")
        .get(id)
        .replace({ _id: id, a: "x", b: 1, v: 3 })
        .run(),
    ).to.equal(1);
    expect((await Table("w_bin_pairs").get(id).run())?.v).to.equal(3);
  });

  it("updates the rows a filter selects, matched back by their key", async () => {
    const changed = await Table("w_bin_pairs")
      .filter((row) => row.key("a").eq("x"))
      .update({ v: 4 })
      .run();
    expect(changed).to.equal(1);
  });

  it("deletes the row by its _id", async () => {
    expect(await Table("w_bin_pairs").get(id).delete().run()).to.equal(1);
    expect(await Table("w_bin_pairs").count().run()).to.equal(0);
  });
});
