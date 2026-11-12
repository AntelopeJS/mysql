import { expect } from "chai";
import { Profile } from "@antelopejs/interface-database-catalog";
import type { Schema } from "@antelopejs/interface-database/schema";

import { RegisterSales, type SalesTables } from "./sales";

let sales: Schema<SalesTables>;

const JUNE = new Date("2024-06-01T00:00:00Z");
const LONG_AGO = new Date("1900-01-01T00:00:00Z");

function Days() {
  return sales.instance().table("zero_days");
}

async function Ids(
  rows: PromiseLike<readonly { _id?: string }[]>,
): Promise<string[]> {
  return (await rows).map((row) => String(row._id)).sort();
}

describe("a zero date, or one with a zero month, in an external table", function () {
  this.timeout(60_000);

  before(async () => {
    sales = await RegisterSales();
  });

  it("reads as absent, on every server version", async () => {
    const rows = await Days().orderBy("id").run();
    expect(
      rows.map((row) => [row.id, row.d ?? null, row.dt ?? null]),
    ).to.deep.equal([
      [1, null, null],
      [2, new Date("2024-01-01T00:00:00Z"), new Date("2024-01-01T10:00:00Z")],
      [3, null, null],
      [4, null, null],
      [5, null, null],
      [6, new Date("2023-12-31T00:00:00Z"), new Date("2023-12-31T23:00:00Z")],
    ]);
  });

  it("satisfies no ordering comparison, as an absent value does", async () => {
    for (const field of ["d", "dt"]) {
      const below = Days().filter((row) => row.key(field).lt(JUNE));
      const above = Days().filter((row) => row.key(field).ge(LONG_AGO));
      expect(await Ids(below.run()), field).to.deep.equal(["2", "6"]);
      expect(await Ids(above.run()), field).to.deep.equal(["2", "6"]);
    }
  });

  it("is unequal to a real date, as an absent value is", async () => {
    const unequal = Days().filter((row) => row.key("d").ne(JUNE));
    expect(await Ids(unequal.run())).to.deep.equal([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
  });

  /**
   * The order is the column's own, which its index serves: sorting a zero month or day with the
   * absent values would sort by an expression, which no index on the column serves.
   */
  it("sorts by its stored value: a zero date first, a zero month or day between the real dates around it", async () => {
    for (const field of ["d", "dt"]) {
      const up = (await Days().orderBy(field).run()).map((row) => row.id);
      const down = (await Days().orderBy(field, "desc").run()).map(
        (row) => row.id,
      );
      expect({ up, down }, field).to.deep.equal({
        up: [4, 1, 6, 3, 2, 5],
        down: [5, 2, 3, 6, 1, 4],
      });
    }
  });

  it("leaves a profile's range to the real dates", async () => {
    const profile = await Profile({ relation: "sales.zero_days" });
    const day = profile.columns.find((column) => column.name === "d");
    expect(day?.range).to.deep.equal({
      status: "ok",
      value: {
        min: "2023-12-31T00:00:00.000Z",
        max: "2024-01-01T00:00:00.000Z",
      },
    });
  });
});
