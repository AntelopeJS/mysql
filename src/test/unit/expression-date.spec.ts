import { expect } from "chai";

import { Compile, Root } from "./pipeline-fixture";
import { Projected } from "./expression-fixture";

const JOINED = "`t0`.`joined`";

function Part(read: Parameters<ReturnType<typeof Root>["map"]>[0]): string {
  return Projected(Compile(Root().map(read)));
}

describe("The date parts", () => {
  it("read each part of a declared date through the engine's own function, as a DOUBLE", () => {
    const parts: readonly [string, string][] = [
      [Part((doc) => doc.key("joined").year()), `YEAR(${JOINED})`],
      [Part((doc) => doc.key("joined").month()), `MONTH(${JOINED})`],
      [Part((doc) => doc.key("joined").day()), `DAYOFMONTH(${JOINED})`],
      [Part((doc) => doc.key("joined").dayofyear()), `DAYOFYEAR(${JOINED})`],
      [Part((doc) => doc.key("joined").hours()), `HOUR(${JOINED})`],
      [Part((doc) => doc.key("joined").minutes()), `MINUTE(${JOINED})`],
    ];
    for (const [sql, reading] of parts) {
      expect(sql).to.equal(`CAST(${reading} AS DOUBLE)`);
    }
  });

  it("number the weekday from Monday 1 to Sunday 7, where DAYOFWEEK starts on Sunday", () => {
    expect(Part((doc) => doc.key("joined").dayofweek())).to.equal(
      `CAST((WEEKDAY(${JOINED}) + 1) AS DOUBLE)`,
    );
  });

  it("carry the fraction of a second, for the second and for the time of day", () => {
    expect(Part((doc) => doc.key("joined").seconds())).to.equal(
      `CAST((EXTRACT(SECOND_MICROSECOND FROM ${JOINED}) / 1000000) AS DOUBLE)`,
    );
    expect(Part((doc) => doc.key("joined").timeofday())).to.equal(
      `CAST((TIME_TO_SEC(${JOINED}) + MICROSECOND(${JOINED}) / 1000000) AS DOUBLE)`,
    );
  });

  it("read the instant as the session holds it, which is UTC, when no zone is named", () => {
    expect(Part((doc) => doc.key("joined").year())).to.not.include(
      "CONVERT_TZ",
    );
  });
});

describe("date_with_timezone", () => {
  it("convert the instant to the zone named before reading a part, binding the zone", () => {
    const bound = Compile(
      Root().map((doc) => doc.key("joined").hours("America/New_York")),
    );
    expect(Projected(bound)).to.equal(
      `CAST(HOUR(CONVERT_TZ(${JOINED}, '+00:00', ?)) AS DOUBLE)`,
    );
    expect(bound.args).to.deep.equal(["America/New_York", ""]);
  });

  it("keep a column addressable through the zone stage, since it only records the zone", () => {
    const sql = Part((doc) => doc.key("joined").day("Asia/Tokyo"));
    expect(sql).to.include(`CONVERT_TZ(${JOINED}, `);
    expect(sql).to.not.include("JSON_");
  });

  it("read the time of day in the zone named", () => {
    expect(Part((doc) => doc.key("joined").timeofday("+05:30"))).to.include(
      `CONVERT_TZ(${JOINED}, '+00:00', ?)`,
    );
  });
});

describe("date_epoch and date_during", () => {
  it("read the instant in seconds from its epoch milliseconds, with no zone", () => {
    const sql = Part((doc) => doc.key("joined").epoch());
    expect(sql).to.include("TIMESTAMPDIFF(MICROSECOND");
    expect(sql).to.include("/ 1000) AS DOUBLE)");
    expect(sql).to.not.include("CONVERT_TZ");
  });

  it("bound low-inclusive and high-exclusive, reading both bounds as instants", () => {
    const sql = Part((doc) => doc.key("joined").during(0, 10));
    expect(sql).to.match(/^\(\(`t0`\.`joined` >= .* AND \(`t0`\.`joined` < /);
    expect(sql).to.include("TIMESTAMPADD(MICROSECOND");
  });

  it("compare dates as instants where a bound is a date", () => {
    const bound = Compile(
      Root().map((doc) =>
        doc
          .key("joined")
          .during(new Date("2020-01-01T00:00:00Z"), new Date("2021-01-01")),
      ),
    );
    expect(bound.args).to.include("2020-01-01T00:00:00.000+00:00");
  });
});
