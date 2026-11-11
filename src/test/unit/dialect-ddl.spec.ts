import { expect } from "chai";

import type { Row } from "../../connection";
import { DIALECTS } from "../../dialect";

const { ddl, catalog } = DIALECTS.mysql;

/** A driver error as `mysql2` reports one: a server error number, and whether the connection died. */
function DriverError(errno?: number, fatal = false): Error {
  return Object.assign(new Error("driver error"), { errno, fatal });
}

function Rows(...rows: Record<string, string | number | null | Buffer>[]) {
  return rows.map((row): Row => new Map(Object.entries(row)));
}

describe("the MySQL DDL failure classification", () => {
  it("retries a lock wait timeout and a deadlock", () => {
    expect(ddl.failure(DriverError(1205))).to.equal("lockTimeout");
    expect(ddl.failure(DriverError(1213))).to.equal("lockTimeout");
  });

  it("reads an object that already exists, or is already gone, as a step already taken", () => {
    for (const errno of [1050, 1060, 1061]) {
      expect(ddl.failure(DriverError(errno)), String(errno)).to.equal(
        "present",
      );
    }
    expect(ddl.failure(DriverError(1091))).to.equal("absent");
  });

  it("tells a killed statement from a statement the server refused", () => {
    expect(ddl.failure(DriverError(1317))).to.equal("interrupted");
    expect(ddl.failure(DriverError(1062))).to.equal("refused");
  });

  it("reads a dead connection as broken whatever its error number, so no step goes on over it", () => {
    expect(ddl.failure(DriverError(1205, true))).to.equal("broken");
    expect(ddl.failure(DriverError())).to.equal("broken");
    expect(ddl.failure(DriverError(-104))).to.equal("broken");
  });
});

describe("the MySQL catalog parser", () => {
  it("reads nothing at the name as no table, and a view as not a table", () => {
    expect(catalog.parseTable([], [], [])).to.equal(undefined);
    const view = catalog.parseTable(
      Rows({ kind: "VIEW", comment: "" }),
      [],
      [],
    );
    expect(view?.kind).to.equal("other");
  });

  it("folds an index's parts into one index, in key order, a functional part without a column", () => {
    const observed = catalog.parseTable(
      Rows({ kind: "BASE TABLE", comment: Buffer.from("owned") }),
      Rows(
        { name: "_id", type: "VARCHAR(512)", extra: "", comment: "" },
        {
          name: "__k_a_00000000",
          type: "varchar(640)",
          extra: "VIRTUAL GENERATED",
          comment: "antelopejs:1:key:x",
        },
      ),
      Rows(
        { name: "a", non_unique: 0, comment: "s", column_name: "_instance" },
        {
          name: "a",
          non_unique: 0,
          comment: "s",
          column_name: "__k_a_00000000",
        },
        { name: "tags", non_unique: 1, comment: "t", column_name: "_instance" },
        { name: "tags", non_unique: 1, comment: "t", column_name: null },
      ),
    );
    expect(observed).to.deep.equal({
      kind: "table",
      comment: "owned",
      columns: [
        { name: "_id", type: "varchar(512)", generated: false, comment: "" },
        {
          name: "__k_a_00000000",
          type: "varchar(640)",
          generated: true,
          comment: "antelopejs:1:key:x",
        },
      ],
      indexes: [
        {
          name: "a",
          unique: true,
          comment: "s",
          columns: ["_instance", "__k_a_00000000"],
        },
        {
          name: "tags",
          unique: false,
          comment: "t",
          columns: ["_instance", undefined],
        },
      ],
    });
  });
});
