import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

import { param, sql } from "../statement";
import { GetDialect, Read } from "../connection";
import type { Nest, Row } from "./watch";

function Nested(levels: number): Nest {
  let value: Nest = "🦌 deep";
  for (let level = 0; level < levels; level += 1) {
    value = { n: value };
  }
  return value;
}

async function Nests(levels: number): Promise<boolean> {
  const text = `${"[".repeat(levels)}${"]".repeat(levels)}`;
  return Read(sql`SELECT JSON_VALID(${param(text)}) AS valid`).then(
    ([row]) => Number(row.get("valid")) === 1,
    () => false,
  );
}

const depth = new Schema<{ rows: Row }>("read-depth", {
  rows: { fields: { label: "string", tree: "object" }, indexes: {} },
});

describe("a plain read that builds a document deeper than the server builds", function () {
  this.timeout(30_000);

  /**
   * MariaDB 11.8 answers SQL NULL with warning 4040 for such a document, so the read answered
   * `null` as the row where MySQL fails it.
   */
  it("fails with the engine's too-deep error, or answers the document where the server builds it", async () => {
    let inColumn = 100;
    while (!(await Nests(inColumn))) {
      inColumn -= 1;
    }
    const rows = depth.instance().table("rows");
    await rows.insert({ _id: "deepest", tree: Nested(inColumn) }).run();
    const read = rows.map((row) => row.merge({ label: "merged" })).run();
    if (await Nests(inColumn + 1)) {
      expect(await read).to.deep.equal([
        { _id: "deepest", label: "merged", tree: Nested(inColumn) },
      ]);
      return;
    }
    const failure: unknown = await read.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(
      failure instanceof Error && GetDialect().capture.tooDeep(failure),
      String(failure),
    ).to.equal(true);
  });
});
