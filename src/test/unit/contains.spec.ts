import { expect } from "chai";

import { Bind, ident, sql } from "../../statement";
import { DIALECTS } from "../../dialect";
import { Contains } from "../../implementations/database/json";
import { ArrayOf, TEXT } from "../../implementations/database/types";
import type { Compiled, RowColumn } from "../../implementations/database/sql";

const MYSQL = DIALECTS.mysql;

const COLUMN = sql`${ident("t0")}.${ident("tags")}`;

const TAGS: RowColumn = {
  alias: "t0",
  keys: [],
  values: [],
  elements: ["tags"],
  source: "tags",
};

function Read(
  path: readonly string[],
  column: RowColumn | undefined,
): Compiled {
  return {
    sql: COLUMN,
    type: ArrayOf(TEXT),
    path: { document: COLUMN, path, column },
  };
}

function Test(array: Compiled): string {
  return Bind(Contains(MYSQL, array, sql`'x'`)).sql;
}

describe("A membership test on an array", () => {
  it("names a column through the expression its multi-valued index is built on", () => {
    expect(Test(Read([], TAGS))).to.equal(
      "('x' MEMBER OF (JSON_EXTRACT(`t0`.`tags`, '$')))",
    );
  });

  it("names a column no multi-valued index covers as it is", () => {
    expect(Test(Read([], { ...TAGS, elements: ["other"] }))).to.equal(
      "('x' MEMBER OF (`t0`.`tags`))",
    );
  });

  it("names a value read from below an indexed column as it is, since the index holds the column's own elements", () => {
    expect(Test(Read(["nested"], TAGS))).to.equal(
      "('x' MEMBER OF (`t0`.`tags`))",
    );
  });

  it("names a column of a subselect, which holds no index, as it is", () => {
    expect(Test(Read([], undefined))).to.equal("('x' MEMBER OF (`t0`.`tags`))");
  });

  it("names a value that is no read of a table's column as it is", () => {
    expect(Test({ sql: COLUMN, type: ArrayOf(TEXT) })).to.equal(
      "('x' MEMBER OF (`t0`.`tags`))",
    );
  });
});
