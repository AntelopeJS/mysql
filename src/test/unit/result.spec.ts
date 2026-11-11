import { expect } from "chai";

import type { Row } from "../../connection";
import { DecodeCell, DecodeRow } from "../../implementations/database/result";
import {
  ArrayOf,
  BOOL,
  FLOAT,
  JsonOf,
  OPAQUE,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";
import type { TableModel } from "../../implementations/database/fields";

const PEOPLE: TableModel = {
  fields: {
    name: { column: "name", type: TEXT },
    age: { column: "age", type: FLOAT },
    isActive: { column: "isActive", type: BOOL },
    joined: { column: "joined", type: TIMESTAMP },
    meta: { column: "meta", type: OPAQUE },
  },
};

function RowOf(cells: Record<string, string | number | null>): Row {
  return new Map(Object.entries(cells));
}

describe("A stored row", () => {
  it("reads the instant a DATETIME holds in UTC, not in the process's zone", () => {
    const decoded = DecodeRow(
      RowOf({
        _id: "a",
        _instance: "",
        joined: "2023-01-15 10:20:30.123456",
        _extra: "{}",
      }),
      PEOPLE,
    );
    expect(decoded.joined).to.deep.equal(new Date("2023-01-15T10:20:30.123Z"));
  });

  it("revives a boolean from the integer the server stores it as", () => {
    const decoded = DecodeRow(
      RowOf({ _id: "a", _instance: "", isActive: 0, _extra: "{}" }),
      PEOPLE,
    );
    expect(decoded.isActive).to.equal(false);
  });

  it("parses a JSON column and leaves a SQL NULL column absent", () => {
    const decoded = DecodeRow(
      RowOf({
        _id: "a",
        _instance: "",
        name: null,
        meta: '{"n": null}',
        _extra: "{}",
      }),
      PEOPLE,
    );
    expect(decoded).to.deep.equal({ _id: "a", meta: { n: null } });
  });

  it("carries a named instance and drops the default one", () => {
    expect(
      DecodeRow(RowOf({ _id: "a", _instance: "x", _extra: "{}" }), PEOPLE),
    ).to.deep.equal({
      _id: "a",
      _instance: "x",
    });
    expect(
      DecodeRow(RowOf({ _id: "a", _instance: "", _extra: "{}" }), PEOPLE),
    ).to.deep.equal({
      _id: "a",
    });
  });

  it("spreads the overflow document beside the fields, the field winning a name both hold", () => {
    const decoded = DecodeRow(
      RowOf({
        _id: "a",
        _instance: "",
        name: "Ann",
        _extra: '{"name": "old", "_id": "z", "k": [1]}',
      }),
      PEOPLE,
    );
    expect(decoded).to.deep.equal({ _id: "a", name: "Ann", k: [1] });
  });
});

describe("A projected cell", () => {
  it("reads a number the server counted, which reaches the driver as text", () => {
    expect(DecodeCell("3", FLOAT)).to.equal(3);
  });

  it("reads a comparison's integer as a boolean, as text or as a number", () => {
    expect(DecodeCell("1", BOOL)).to.equal(true);
    expect(DecodeCell(0, BOOL)).to.equal(false);
  });

  it("revives the instants a JSON shape declares, from the ISO text JSON holds them as", () => {
    const type = JsonOf({ at: TIMESTAMP, tags: ArrayOf(TEXT) });
    expect(
      DecodeCell('{"at": "2023-01-15T00:00:00.000Z", "tags": ["a"]}', type),
    ).to.deep.equal({
      at: new Date("2023-01-15T00:00:00.000Z"),
      tags: ["a"],
    });
  });

  it("answers null for SQL NULL whatever the type", () => {
    expect(DecodeCell(null, OPAQUE)).to.equal(null);
    expect(DecodeCell(null, TIMESTAMP)).to.equal(null);
  });

  it("keeps a JSON null apart from SQL NULL", () => {
    expect(DecodeCell("null", OPAQUE)).to.equal(null);
    expect(DecodeCell("[null]", ArrayOf(OPAQUE))).to.deep.equal([null]);
  });
});
