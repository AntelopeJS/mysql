import { expect } from "chai";
import {
  type Categories,
  Profile,
  type RelationProfile,
} from "@antelopejs/interface-database-catalog";

import type { RelationRow } from "../dialect/external";
import { SourceFor } from "../implementations/database/external-sample";
import { type Sql, ident, int, sql } from "../statement";
import { Received } from "./received";
import { type NativeCell, Native } from "./sales";

const CATEGORY_LIMIT = 25;
const CATEGORY_MIN_ROWS = 5;
const SAMPLE_TARGET_ROWS = 100_000;
const PERCENT = 100;

type CategoryValue = string | number | boolean;

/** The categories the profile answered before the fold moved into the query, from the same rows. */
async function Reference(
  expression: (column: Sql) => Sql,
  from: Sql,
  column: string,
  read: (cell: NativeCell) => CategoryValue,
): Promise<Categories> {
  const rows = await Native(
    sql`SELECT ${expression(sql`r.${ident(column)}`)} AS category, COUNT(*) AS category_rows FROM ${from}
      WHERE r.${ident(column)} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${int(CATEGORY_LIMIT + 1)}`,
  );
  const counts = rows.map((row) => ({
    value: read(row.category),
    rows: Number(row.category_rows),
  }));
  return {
    values: counts.filter((count) => count.rows >= CATEGORY_MIN_ROWS),
    other: counts
      .filter((count) => count.rows < CATEGORY_MIN_ROWS)
      .reduce((total, count) => total + count.rows, 0),
  };
}

function CategoriesOf(profile: RelationProfile, column: string): Categories {
  const categories = profile.columns.find(
    (profiled) => profiled.name === column,
  )?.categories;
  expect(categories?.status, column).to.equal("ok");
  return categories?.status === "ok"
    ? categories.value
    : { values: [], other: 0 };
}

function Relation(name: string): RelationRow {
  return {
    schema: "sales",
    name,
    kind: "table",
    readable: true,
    someColumns: false,
    insert: false,
    update: false,
    statistics: null,
    comment: null,
  };
}

const AsChar = (value: Sql) => sql`CAST(${value} AS CHAR)`;
const AsText = (cell: NativeCell) => String(cell);
const AsNumber = (cell: NativeCell) => Number(cell);
const AsBoolean = (cell: NativeCell) => Number(cell) !== 0;

describe("the categories of an external column", function () {
  this.timeout(120_000);

  const columns = [
    {
      relation: "invoices",
      column: "kind",
      expression: AsChar,
      read: AsText,
    },
    {
      relation: "accounts",
      column: "status",
      expression: AsChar,
      read: AsText,
    },
    {
      relation: "accounts",
      column: "active",
      expression: (value: Sql) => sql`((${value}) <> 0)`,
      read: AsBoolean,
    },
    {
      relation: "order_lines",
      column: "qty",
      expression: (value: Sql) => sql`CAST(${value} AS DOUBLE)`,
      read: AsNumber,
    },
  ];
  for (const { relation, column, expression, read } of columns) {
    it(`answers ${relation}.${column} as it did when the fold ran in the driver`, async () => {
      const profile = await Profile({
        relation: `sales.${relation}`,
        columns: [column],
      });
      const expected = await Reference(
        expression,
        SourceFor(Relation(relation), null, []).from,
        column,
        read,
      );
      expect(JSON.stringify(CategoriesOf(profile, column))).to.equal(
        JSON.stringify(expected),
      );
    });
  }

  it("folds a value seen fewer than 5 times in the database, so no result set holds it", async () => {
    const { answer, results } = await Received(() =>
      Profile({ relation: "sales.invoices", columns: ["kind"] }),
    );
    expect(CategoriesOf(answer, "kind").other).to.equal(2);
    expect(results).to.include('"paid"');
    expect(results).to.not.include("disputed");
  });

  it("names a value seen 5 times and folds one seen 4 times in the database", async () => {
    const { answer, results } = await Received(() =>
      Profile({ relation: "sales.tallies", columns: ["label"] }),
    );
    expect(CategoriesOf(answer, "label")).to.deep.equal({
      values: [
        { value: "many", rows: 20 },
        { value: "five", rows: 5 },
      ],
      other: 4,
    });
    expect(results).to.include('"five"');
    expect(results).to.not.include("four");
  });

  it("folds a value seen fewer than 5 times in a sample in the database, as it did in the driver", async () => {
    const { answer, results } = await Received(() =>
      Profile({ relation: "sales.big_events", columns: ["kind"] }),
    );
    expect(answer.sample).to.not.equal(null);
    const estimate = Math.round(
      (SAMPLE_TARGET_ROWS * PERCENT) / (answer.sample?.percent ?? PERCENT),
    );
    const categories = CategoriesOf(answer, "kind");
    expect(categories.other).to.be.above(0);
    const expected = await Reference(
      AsChar,
      SourceFor(Relation("big_events"), estimate, ["id"]).from,
      "kind",
      AsText,
    );
    expect(JSON.stringify(categories)).to.equal(JSON.stringify(expected));
    expect(results).to.include('"click"');
    expect(results).to.not.include("refund");
  });
});
