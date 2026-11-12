import { expect } from "chai";
import type { SchemaDefinition } from "@antelopejs/interface-database/schema";

import { ident, sql } from "../statement";
import { AcquireConnection, GetSchemaPrefix, Read } from "../connection";
import { TableName } from "../implementations/database/identifier";
import { SessionOf } from "../implementations/database/locks";
import { Schemas } from "../implementations/database/schema";

const SCHEMA_ID = "backfill_types";

const UNDECLARED: SchemaDefinition = { items: { fields: {}, indexes: {} } };

const DECLARED: SchemaDefinition = {
  items: {
    fields: {
      s: "string",
      n: "number",
      b: "boolean",
      d: "date",
      o: "object",
      l: "string[]",
    },
    indexes: {},
  },
};

const TABLE = ident(TableName("", SCHEMA_ID, "items"));

/**
 * `typed` holds a value of each declared type; `mistyped` holds values none of the columns can take;
 * `nulls` holds JSON null under every key; `impossible` holds a date-shaped string naming no day.
 */
const ROWS = sql`('typed', '', '{"s": "x", "n": 1.5, "b": true, "d": "2024-01-02T03:04:05.678Z", "o": {"k": 1}, "l": ["a"], "keep": 1}'),
  ('mistyped', '', '{"s": 5, "n": "7", "b": "true", "d": "yesterday", "keep": 2}'),
  ('nulls', '', '{"s": null, "n": null, "b": null, "d": null, "o": null, "l": null}'),
  ('impossible', '', '{"d": "2024-02-30T00:00:00.000Z"}')`;

/** The declared columns as text, and `_extra` as the server prints JSON: keys by length, then name. */
interface Stored {
  readonly columns: readonly string[];
  readonly extra: string;
}

async function Stored(): Promise<Map<string, Stored>> {
  const rows = await Read(
    sql`SELECT _id, s, n, b, DATE_FORMAT(d, '%Y-%m-%dT%H:%i:%s.%f') AS d, o, l, _extra FROM ${TABLE} ORDER BY _id`,
  );
  return new Map(
    rows.map((row) => [
      String(row.get("_id")),
      {
        columns: ["s", "n", "b", "d", "o", "l"].map((column) =>
          String(row.get(column)),
        ),
        extra: String(row.get("_extra")),
      },
    ]),
  );
}

describe("a field declared over values already in _extra", () => {
  let stored: Map<string, Stored>;

  before(async () => {
    const connection = await AcquireConnection();
    try {
      const session = SessionOf(connection);
      await session.apply(sql`DROP TABLE IF EXISTS ${TABLE}`);
      expect(GetSchemaPrefix()).to.equal("");
      await Schemas.register(SCHEMA_ID, UNDECLARED);
      await session.apply(
        sql`INSERT INTO ${TABLE} (_id, _instance, _extra) VALUES ${ROWS}`,
      );
    } finally {
      connection.release();
    }
    await Schemas.register(SCHEMA_ID, DECLARED);
    stored = await Stored();
  });

  after(() => {
    Schemas.unregister(SCHEMA_ID);
  });

  it("moves a value of each declared type into its column and out of _extra", () => {
    expect(stored.get("typed")).to.deep.equal({
      columns: [
        "x",
        "1.5",
        "1",
        "2024-01-02T03:04:05.678000",
        '{"k": 1}',
        '["a"]',
      ],
      extra: '{"keep": 1}',
    });
  });

  it("leaves a value its column cannot hold in _extra, and the column empty", () => {
    expect(stored.get("mistyped")).to.deep.equal({
      columns: ["null", "null", "null", "null", "null", "null"],
      extra: '{"b": "true", "d": "yesterday", "n": "7", "s": 5, "keep": 2}',
    });
  });

  it("leaves an explicit null in _extra, where it still reads as null", () => {
    expect(stored.get("nulls")).to.deep.equal({
      columns: ["null", "null", "null", "null", "null", "null"],
      extra:
        '{"b": null, "d": null, "l": null, "n": null, "o": null, "s": null}',
    });
  });

  it("leaves a date-shaped string that names no day in _extra", () => {
    expect(stored.get("impossible")).to.deep.equal({
      columns: ["null", "null", "null", "null", "null", "null"],
      extra: '{"d": "2024-02-30T00:00:00.000Z"}',
    });
  });
});
