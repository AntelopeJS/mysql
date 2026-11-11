import { expect } from "chai";

import { type Sql, param, sql } from "../statement";
import { AcquireConnection, Read, type Row } from "../connection";

const SESSION = sql`SELECT @@collation_connection AS collation, @@character_set_connection AS charset, @@time_zone AS zone, @@sql_mode AS mode, @@lc_messages AS messages`;

function Only(rows: readonly Row[]): Row {
  expect(rows).to.have.length(1);
  return rows[0];
}

function expectPinned(row: Row) {
  expect(row.get("collation")).to.equal("utf8mb4_0900_bin");
  expect(row.get("charset")).to.equal("utf8mb4");
  expect(row.get("zone")).to.equal("+00:00");
  expect(row.get("messages")).to.equal("en_US");
  const modes = String(row.get("mode")).split(",");
  expect(modes).to.include("STRICT_ALL_TABLES");
  expect(modes).to.include("NO_ZERO_DATE");
  expect(modes).to.not.include("NO_BACKSLASH_ESCAPES");
  expect(modes).to.not.include("ONLY_FULL_GROUP_BY");
  expect(modes).to.not.include("PIPES_AS_CONCAT");
  expect(modes).to.not.include("ANSI_QUOTES");
}

async function Value(statement: Sql) {
  return Only(await Read(statement)).get("value");
}

describe("a pooled connection", () => {
  it("runs the session pin before its first statement", async () => {
    expectPinned(Only(await Read(SESSION)));
  });

  it("compares bound text in the binary NO PAD collation", async () => {
    expect(await Value(sql`SELECT COLLATION(${param("a")}) AS value`)).to.equal(
      "utf8mb4_0900_bin",
    );
    const equal = async (left: string, right: string) =>
      Number(
        await Value(sql`SELECT ${param(left)} = ${param(right)} AS value`),
      );
    expect(await equal("a", "a")).to.equal(1);
    expect(await equal("a", "a ")).to.equal(0);
    expect(await equal("a", "A")).to.equal(0);
  });

  it("binds a value once per occurrence through the prepared protocol", async () => {
    const twice = param(21);
    expect(await Value(sql`SELECT ${twice} + ${twice} AS value`)).to.equal(42);
  });
});

describe("a held connection", () => {
  it("is pinned as a pooled one is, and keeps its pin across checkouts", async () => {
    for (let checkout = 0; checkout < 2; checkout += 1) {
      const held = await AcquireConnection();
      try {
        expectPinned(Only(await Read(SESSION, held)));
      } finally {
        held.release();
      }
    }
  });
});
