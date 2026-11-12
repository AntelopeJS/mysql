import { expect } from "chai";
import type { Schema } from "@antelopejs/interface-database/schema";

import { type Sql, ident, sql } from "../statement";
import { ExternalWriteError } from "../implementations/database/external-errors";
import { NativeWrite, RegisterSales, type SalesTables } from "./sales";

let sales: Schema<SalesTables>;

function Table(tableId: string) {
  return sales.instance().table(tableId);
}

function Rows(table: string): Sql {
  return sql`${ident("sales")}.${ident(table)}`;
}

const EMOJI = "😀";
const CJK = "日本";

async function Reset(): Promise<void> {
  await NativeWrite(sql`DELETE FROM ${Rows("w_names")}`);
  await NativeWrite(
    sql`INSERT INTO ${Rows("w_names")} VALUES (1, 'Abc', 'b  ', 'b  ', 'abc', 'Red'), (2, 'cafe', NULL, NULL, NULL, NULL)`,
  );
  await NativeWrite(sql`DELETE FROM ${Rows("w_codes")}`);
  await NativeWrite(
    sql`INSERT INTO ${Rows("w_codes")} VALUES ('FR', 'France'), ('??', 'two marks')`,
  );
}

/** What a write that should be refused answered: an `ExternalWriteError`'s kind and fields, or anything else's message. */
async function Refusal(
  work: () => PromiseLike<number>,
): Promise<{ kind: string; fields: string[] } | string> {
  try {
    await work();
    return "the write was not refused";
  } catch (err) {
    return err instanceof ExternalWriteError
      ? { kind: err.kind, fields: err.fields }
      : String(err);
  }
}

describe("a write to a text column compared in a collation that folds case, accents or trailing spaces", function () {
  this.timeout(60_000);

  beforeEach(async () => {
    sales = await RegisterSales();
    await Reset();
  });

  it("writes a value that differs from the stored one only in case or in an accent", async () => {
    expect(
      await Table("w_names").get("1").update({ name: "ABC" }).run(),
    ).to.equal(1);
    expect(
      await Table("w_names").get("2").update({ name: "café" }).run(),
    ).to.equal(1);
    const names = (await Table("w_names").orderBy("id").run()).map(
      (row) => row.name,
    );
    expect(names).to.deep.equal(["ABC", "café"]);
  });

  it("writes a value that differs only in its trailing spaces, under PAD SPACE", async () => {
    const changed = await Table("w_names")
      .get("1")
      .update({ padded: "b", legacy: "b" })
      .run();
    expect(changed).to.equal(1);
    const row = await Table("w_names").get("1").run();
    expect({ padded: row?.padded, legacy: row?.legacy }).to.deep.equal({
      padded: "b",
      legacy: "b",
    });
  });

  it("still answers 0 for a write of exactly what a read answers", async () => {
    expect(
      await Table("w_names")
        .get("1")
        .update({ name: "Abc", padded: "b  " })
        .run(),
    ).to.equal(0);
  });

  it("answers 0 for an ENUM write of the stored label, in its own case or in another, which stores that label", async () => {
    const changed = [];
    for (const color of ["Red", "red"]) {
      changed.push(await Table("w_names").get("1").update({ color }).run());
    }
    const stored = (await Table("w_names").get("1").run())?.color;
    expect({ changed, stored }).to.deep.equal({
      changed: [0, 0],
      stored: "Red",
    });
  });

  it("answers 1 for an ENUM write of another label", async () => {
    const changed = await Table("w_names")
      .get("1")
      .update({ color: "Green" })
      .run();
    const stored = (await Table("w_names").get("1").run())?.color;
    expect({ changed, stored }).to.deep.equal({ changed: 1, stored: "Green" });
  });

  it("refuses an ENUM write that names no label, a label's position included", async () => {
    for (const color of ["Blue", "1"]) {
      const refused = await Refusal(() =>
        Table("w_names").get("1").update({ color }).run(),
      );
      expect(refused, color).to.deep.equal({
        kind: "invalid",
        fields: ["color"],
      });
    }
  });
});

describe("a value a text column's character set cannot hold", function () {
  this.timeout(60_000);

  beforeEach(async () => {
    sales = await RegisterSales();
    await Reset();
  });

  it("matches nothing in a comparison, where a value the set holds matches", async () => {
    const narrow = await Table("w_names")
      .filter((row) => row.key("narrow").eq(EMOJI))
      .run();
    const legacy = await Table("w_names")
      .filter((row) => row.key("legacy").eq(CJK))
      .run();
    const held = await Table("w_names")
      .filter((row) => row.key("narrow").eq("abc"))
      .run();
    expect([narrow.length, legacy.length, held.length]).to.deep.equal([
      0, 0, 1,
    ]);
  });

  it("finds no row by a key the key column cannot hold, rather than the row its replacement marks name", async () => {
    expect(await Table("w_codes").get(CJK).run()).to.equal(undefined);
    expect((await Table("w_codes").get("??").run())?.label).to.equal(
      "two marks",
    );
  });

  it("refuses a write of it as an invalid value of the field", async () => {
    for (const [field, value] of [
      ["narrow", EMOJI],
      ["legacy", CJK],
    ] as const) {
      const refused = await Refusal(() =>
        Table("w_names")
          .get("1")
          .update({ [field]: value })
          .run(),
      );
      expect(refused, field).to.deep.equal({
        kind: "invalid",
        fields: [field],
      });
    }
  });
});
