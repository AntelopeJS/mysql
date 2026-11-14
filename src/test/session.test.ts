import { expect } from "chai";

import {
  type Sql,
  Bind,
  ident,
  int,
  join,
  lit,
  param,
  sql,
} from "../statement";
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

/** A sort buffer smaller than MariaDB's default, which a sort of the pinned length outgrows. */
const SMALL_SORT_BUFFER = 262144;

/** A sort buffer larger than the least the pin keeps, which the pin leaves as it is. */
const LARGE_SORT_BUFFER = 8388608;

/** The most texts one sort reads by in the sort buffer the MariaDB pin keeps. */
const SORT_TEXTS = 8;

/** Two rows that only the last of their texts sets apart, so the sort reads every one. */
function SortedTexts(): Sql {
  const row = (last: string) =>
    JSON.stringify([
      ...Array.from({ length: SORT_TEXTS - 1 }, () => "s"),
      last,
    ]);
  const columns = Array.from({ length: SORT_TEXTS }, (_, text) =>
    ident(`c${text}`),
  );
  const definitions = columns.map(
    (column, text) => sql`${column} LONGTEXT PATH ${lit(`$[${text}]`)}`,
  );
  const last = ident(`c${SORT_TEXTS - 1}`);
  return sql`SELECT ${last} AS value FROM JSON_TABLE(${param(`[${row("b")},${row("a")}]`)}, '$[*]' COLUMNS (${join(definitions, sql`, `)})) AS j ORDER BY ${join(columns, sql`, `)}`;
}

/** Runs the pin again on a held session that starts with `buffer` and the server's `sql_mode`. */
async function Repin(
  held: Awaited<ReturnType<typeof AcquireConnection>>,
  buffer: number,
): Promise<void> {
  await Write(
    sql`SET SESSION sort_buffer_size = ${int(buffer)}, sql_mode = @@global.sql_mode`,
    held,
  );
  await held.query(Bind(GetDialect().session.pin({})).sql);
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

  it("pins a session that starts in strict mode", async () => {
    const held = await AcquireConnection();
    try {
      await Write(sql`SET SESSION sql_mode = 'STRICT_ALL_TABLES'`, held);
      await held.query(Bind(GetDialect().session.pin({})).sql);
      expectPinned(Only(await Read(SESSION, held)));
    } finally {
      held.release();
    }
  });

  it("sorts by eight texts after its pin, from a small sort buffer", async () => {
    const held = await AcquireConnection();
    try {
      await Repin(held, SMALL_SORT_BUFFER);
      const rows = await Read(SortedTexts(), held);
      expect(rows.map((row) => row.get("value"))).to.deep.equal(["a", "b"]);
    } finally {
      held.release();
    }
  });

  it("keeps a sort buffer larger than its pin's least", async () => {
    const held = await AcquireConnection();
    try {
      await Repin(held, LARGE_SORT_BUFFER);
      const buffer = await Read(sql`SELECT @@sort_buffer_size AS value`, held);
      expect(Number(Only(buffer).get("value"))).to.equal(LARGE_SORT_BUFFER);
    } finally {
      held.release();
    }
  });
});
