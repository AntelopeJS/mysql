import { expect } from "chai";

import { type Sql, Bind, int, param, sql } from "../statement";
import {
  AcquireConnection,
  GetDialect,
  Read,
  type Row,
  Write,
} from "../connection";

const SESSION = sql`SELECT @@collation_connection AS collation, @@character_set_connection AS charset, @@time_zone AS zone, @@sql_mode AS mode, @@lc_messages AS messages`;

function Only(rows: readonly Row[]): Row {
  expect(rows).to.have.length(1);
  return rows[0];
}

function expectPinned(row: Row) {
  expect(row.get("collation")).to.equal(GetDialect().session.binaryCollation);
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

/**
 * A sort buffer smaller than MariaDB's default, which a sort of the pinned length outgrows. The
 * session takes it with the server's `sql_mode`, as a new connection starts, since the pinned strict
 * mode refuses the pin's `group_concat_max_len` where the server clamps it.
 */
const SMALL_SORT_BUFFER = 262144;

const SORTED_TEXTS = sql`SELECT v AS value FROM JSON_TABLE('["b","a"]', '$[*]' COLUMNS (v LONGTEXT PATH '$')) AS j ORDER BY v`;

async function Value(statement: Sql) {
  return Only(await Read(statement)).get("value");
}

describe("a pooled connection", () => {
  it("runs the session pin before its first statement", async () => {
    expectPinned(Only(await Read(SESSION)));
  });

  it("compares bound text in the binary NO PAD collation", async () => {
    expect(await Value(sql`SELECT COLLATION(${param("a")}) AS value`)).to.equal(
      GetDialect().session.binaryCollation,
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

  it("sorts a text column after its pin, whatever sort buffer the session had", async () => {
    const held = await AcquireConnection();
    try {
      await Write(
        sql`SET SESSION sort_buffer_size = ${int(SMALL_SORT_BUFFER)}, sql_mode = @@global.sql_mode`,
        held,
      );
      await held.query(Bind(GetDialect().session.pin({})).sql);
      const rows = await Read(SORTED_TEXTS, held);
      expect(rows.map((row) => row.get("value"))).to.deep.equal(["a", "b"]);
    } finally {
      held.release();
    }
  });
});
