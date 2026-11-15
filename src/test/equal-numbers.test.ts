import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

import { AcquireConnection, GetDialect, Read } from "../connection";
import { type Sql, ident, join, param, sql } from "../statement";
import { Compiled } from "./compiled";
import { PhysicalTable, Run } from "./tables";

const SCHEMA_ID = "equal_numbers";

/**
 * Spellings of JSON numbers another writer stores, which MySQL's JSON `=` and orderings tell apart
 * where a double holding both would not, or find equal where their text differs.
 */
const NUMBERS = [
  "18446744073709549568e0",
  "18446744073709550000",
  "18446744073709549568",
  "9223372036854774784e0",
  "9223372036854775000",
  "9223372036854774784",
  "-9223372036854775808",
  "-9223372036854775808e0",
  "100000000000000000001",
  "1e20",
  "1e19",
  "10000000000000000000",
  "9007199254740993",
  "9007199254740992e0",
  "1",
  "1.0",
  "1e0",
  "0.5",
  "5e-1",
  "0.1",
  "0.10000000000000001",
  "4e-324",
  "5e-324",
  "2e-324",
  "0",
  "1e-400",
  "18446744073709551615",
  "1.8446744073709552e19",
  "18446744073709551616",
] as const;

/** Spellings of numbers beyond the doubles, which MariaDB stores as written and MySQL refuses. */
const OVERFLOWS = ["1e309", "1E309", "1e+309", "10e308", "-1e309"] as const;

/** The values {@link OVERFLOWS} spell: four spellings of 10^309 and one of -10^309. */
const OVERFLOW_VALUES = 2;

/** The ordered pairs of {@link OVERFLOWS} of one value: 4 × 4 and 1 × 1. */
const OVERFLOW_PAIRS = 17;

const SIGNED_MIN = -(2n ** 63n);
const UNSIGNED_MAX = 2n ** 64n - 1n;

/**
 * The value MySQL compares a number by: an integer literal from -2^63 to 2^64 - 1 exactly, and any
 * other number as the double it parses to, an integral one by the digits of its shortest decimal.
 * Each integral number of {@link NUMBERS} is below 10^21, which JavaScript writes without an exponent.
 */
function MysqlValue(text: string): bigint | number {
  if (/^-?[0-9]+$/.test(text)) {
    const exact = BigInt(text);
    if (exact >= SIGNED_MIN && exact <= UNSIGNED_MAX) {
      return exact;
    }
  }
  const double = Number(text);
  return Number.isInteger(double) ? BigInt(double.toString()) : double;
}

/** Whether MySQL finds two numbers equal: neither below the other. */
function Same(left: string, right: string): boolean {
  const [l, r] = [MysqlValue(left), MysqlValue(right)];
  return !(l < r) && !(l > r);
}

/** What `lt`, `eq`, `gt`, `le` and `ge` answer for two numbers, as MySQL compares them. */
function Order(left: string, right: string): string {
  const [l, r] = [MysqlValue(left), MysqlValue(right)];
  const same = Same(left, right);
  return JSON.stringify([l < r, same, l > r, l < r || same, l > r || same]);
}

interface Pair {
  _id: string;
  l?: number;
  r?: number;
  la?: number[];
  ra?: number[];
}

interface Single {
  _id: string;
  n?: number;
  na?: number[];
}

const schema = new Schema<{
  pairs: Pair;
  singles: Single;
  overflows: Single;
  overflowPairs: Pair;
  wrapped: Single;
}>(SCHEMA_ID, {
  pairs: { fields: {}, indexes: {} },
  singles: { fields: {}, indexes: {} },
  overflows: { fields: {}, indexes: {} },
  overflowPairs: { fields: {}, indexes: {} },
  wrapped: { fields: {}, indexes: {} },
});

/** Each ordered pair of numbers MySQL finds equal, as `left right` texts. */
const EQUAL = NUMBERS.flatMap((left) =>
  NUMBERS.filter((right) => Same(left, right)).map(
    (right) => `${left} ${right}`,
  ),
).sort();

/** The texts of the numbers at `indexes`, joined by a space. */
function Texts(indexes: readonly string[]): string {
  return indexes.map((index) => NUMBERS[Number(index)]).join(" ");
}

/** Rows of `table` with their `_id` and their undeclared keys, in the default instance. */
function Insert(table: string, rows: readonly (readonly [string, Sql])[]): Sql {
  const values = rows.map(([id, extra]) => sql`(${param(id)}, '', ${extra})`);
  return sql`INSERT INTO ${ident(PhysicalTable(SCHEMA_ID, table))} (_id, _instance, _extra) VALUES ${join(values, sql`, `)}`;
}

/** A number's JSON text as the server parses it. */
function Parsed(text: string): Sql {
  return sql`JSON_EXTRACT(${param(text)}, '$')`;
}

describe("eq on JSON numbers another writer spelled", function () {
  this.timeout(30_000);

  before(async () => {
    await schema.instance().table("pairs").delete().run();
    await schema.instance().table("singles").delete().run();
    await Run(
      Insert(
        "pairs",
        NUMBERS.flatMap((left, l) =>
          NUMBERS.map(
            (right, r) =>
              [
                `${l}-${r}`,
                sql`JSON_OBJECT('l', ${Parsed(left)}, 'r', ${Parsed(right)}, 'la', JSON_ARRAY(${Parsed(left)}), 'ra', JSON_ARRAY(${Parsed(right)}))`,
              ] as const,
          ),
        ),
      ),
    );
    await Run(
      Insert(
        "singles",
        NUMBERS.map(
          (number, index) =>
            [
              String(index),
              sql`JSON_OBJECT('n', ${Parsed(number)}, 'na', JSON_ARRAY(${Parsed(number)}))`,
            ] as const,
        ),
      ),
    );
  });

  it("answers as MySQL's JSON = between two keys of a row", async () => {
    const ids = await schema
      .instance()
      .table("pairs")
      .filter((row) => row.key("l").eq(row.key("r")))
      .map((row) => row.key("_id"))
      .run();
    expect(ids.map((id) => Texts(id.split("-"))).sort()).to.deep.equal(EQUAL);
  });

  it("answers as MySQL's JSON = between two arrays of one number", async () => {
    const ids = await schema
      .instance()
      .table("pairs")
      .filter((row) => row.key("la").eq(row.key("ra")))
      .map((row) => row.key("_id"))
      .run();
    expect(ids.map((id) => Texts(id.split("-"))).sort()).to.deep.equal(EQUAL);
  });

  it("answers as MySQL's JSON = between two arrays of one number in a join that hashes them", async () => {
    const pairs = await schema
      .instance()
      .table("singles")
      .joinInner(
        schema.instance().table("singles"),
        (left, right) => left.key("na").eq(right.key("na")),
        (left, right) => ({ left: left.key("_id"), right: right.key("_id") }),
      )
      .run();
    expect(
      pairs.map(({ left, right }) => Texts([left, right])).sort(),
    ).to.deep.equal(EQUAL);
  });

  it("orders two keys of a row as MySQL's JSON orderings do", async () => {
    const rows = await schema
      .instance()
      .table("pairs")
      .map((row) => ({
        id: row.key("_id"),
        lt: row.key("l").lt(row.key("r")),
        eq: row.key("l").eq(row.key("r")),
        gt: row.key("l").gt(row.key("r")),
        le: row.key("l").le(row.key("r")),
        ge: row.key("l").ge(row.key("r")),
      }))
      .run();
    const read = rows
      .map(({ id, lt, eq, gt, le, ge }) => {
        const [left, right] = Texts(id.split("-")).split(" ");
        return `${left} ${right} ${JSON.stringify([lt, eq, gt, le, ge])}`;
      })
      .sort();
    const expected = NUMBERS.flatMap((left) =>
      NUMBERS.map((right) => `${left} ${right} ${Order(left, right)}`),
    ).sort();
    expect(read).to.deep.equal(expected);
  });

  it("answers as MySQL's JSON = in a join that hashes the key", async () => {
    const pairs = await schema
      .instance()
      .table("singles")
      .joinInner(
        schema.instance().table("singles"),
        (left, right) => left.key("n").eq(right.key("n")),
        (left, right) => ({ left: left.key("_id"), right: right.key("_id") }),
      )
      .run();
    expect(
      pairs.map(({ left, right }) => Texts([left, right])).sort(),
    ).to.deep.equal(EQUAL);
  });
});

describe("eq on JSON numbers beyond the doubles", function () {
  this.timeout(30_000);

  before(async function () {
    if (GetDialect().id !== "mariadb") {
      this.skip();
    }
    await schema.instance().table("overflows").delete().run();
    await schema.instance().table("overflowPairs").delete().run();
    await Run(
      Insert(
        "overflows",
        OVERFLOWS.map(
          (number, index) =>
            [
              String(index),
              sql`JSON_OBJECT('n', ${Parsed(number)}, 'na', JSON_ARRAY(${Parsed(number)}))`,
            ] as const,
        ),
      ),
    );
    await Run(
      Insert(
        "overflowPairs",
        OVERFLOWS.flatMap((left, l) =>
          OVERFLOWS.map(
            (right, r) =>
              [
                `${l}-${r}`,
                sql`JSON_OBJECT('l', ${Parsed(left)}, 'r', ${Parsed(right)}, 'la', JSON_ARRAY(${Parsed(left)}), 'ra', JSON_ARRAY(${Parsed(right)}))`,
              ] as const,
          ),
        ),
      ),
    );
  });

  it("finds in a join that hashes the key the pairs eq finds between two keys of a row", async () => {
    const joined = await schema
      .instance()
      .table("overflows")
      .joinInner(
        schema.instance().table("overflows"),
        (left, right) => left.key("n").eq(right.key("n")),
        (left, right) => ({ left: left.key("_id"), right: right.key("_id") }),
      )
      .run();
    const equal = await schema
      .instance()
      .table("overflowPairs")
      .filter((row) => row.key("l").eq(row.key("r")))
      .map((row) => row.key("_id"))
      .run();
    expect(
      joined.map(({ left, right }) => `${left}-${right}`).sort(),
    ).to.deep.equal(equal.sort());
  });

  it("keeps one value per number eq finds equal, at the top and in an array", async () => {
    const overflows = () => schema.instance().table("overflows");
    const pairs = () => schema.instance().table("overflowPairs");
    const counts = await Promise.all([
      overflows().distinct("n").count().run(),
      overflows().distinct("na").count().run(),
      pairs()
        .filter((row) => row.key("l").eq(row.key("r")))
        .count()
        .run(),
      pairs()
        .filter((row) => row.key("la").eq(row.key("ra")))
        .count()
        .run(),
    ]);
    expect(counts).to.deep.equal([
      OVERFLOW_VALUES,
      OVERFLOW_VALUES,
      OVERFLOW_PAIRS,
      OVERFLOW_PAIRS,
    ]);
  });

  /**
   * MariaDB's cast of such a number to a double warns that it truncated it, once for each row a
   * read compares, so a read over enough rows raises more warnings than MariaDB lists and a cut
   * aggregate or a too-deep document among them goes unseen.
   */
  it("compares them without a warning", async () => {
    const overflows = () => schema.instance().table("overflows");
    const pairs = () => schema.instance().table("overflowPairs");
    const reads = [
      overflows().joinInner(
        overflows(),
        (left, right) => left.key("n").eq(right.key("n")),
        (left) => left.key("_id"),
      ),
      overflows().distinct("n"),
      overflows().distinct("na"),
      overflows().group("n", (rows) => ({ size: rows.count() })),
      pairs().filter((row) => row.key("l").eq(row.key("r"))),
      pairs().filter((row) => row.key("la").eq(row.key("ra"))),
      pairs().filter((row) => row.key("la").includes(row.key("r"))),
    ];
    const held = await AcquireConnection();
    const warnings: number[] = [];
    try {
      for (const read of reads) {
        await Read(Compiled(read), held);
        const [counted] = await Read(sql`SELECT @@warning_count AS w`, held);
        warnings.push(Number(counted?.get("w")));
      }
    } finally {
      held.release();
    }
    expect(warnings).to.deep.equal(reads.map(() => 0));
  });
});

/**
 * Numbers whose exponent passes a 64-bit integer, which `JSON_NORMALIZE` wraps to the other end:
 * two that cast to 0, two that cast to the greatest double, and one whose exponent passes the 65
 * digits a decimal holds, which keeps its own text as {@link OVERFLOWS} do.
 */
const WRAPPED = [
  "0",
  "0.5e-9223372036854775808",
  "17.976931348623157e99999999999999999999999",
  "179.76931348623157e99999999999999999999999",
  `1e${"9".repeat(66)}`,
] as const;

describe("eq on JSON numbers whose exponent passes a 64-bit integer", function () {
  this.timeout(30_000);

  before(async function () {
    if (GetDialect().id !== "mariadb") {
      this.skip();
    }
    await schema.instance().table("wrapped").delete().run();
    await Run(
      Insert(
        "wrapped",
        WRAPPED.map(
          (number, index) =>
            [String(index), sql`JSON_OBJECT('n', ${Parsed(number)})`] as const,
        ),
      ),
    );
  });

  /**
   * MariaDB casts the first two to 0 and the next two to the greatest double, and the last keeps
   * its text, so they make three values; a key that took `JSON_NORMALIZE`'s wrapped exponent for
   * the number's would key the second as past the doubles, one that cast the next two would warn
   * for each, and one that read the last one's exponent as a decimal would warn that it overflows.
   */
  it("keys each as MariaDB's cast reads it, without a warning", async () => {
    const wrapped = () => schema.instance().table("wrapped");
    const held = await AcquireConnection();
    try {
      const [values] = await Read(
        Compiled(wrapped().distinct("n").count()),
        held,
      );
      const [counted] = await Read(sql`SELECT @@warning_count AS w`, held);
      const zeros = await wrapped()
        .filter((row) => row.key("n").eq(0))
        .map((row) => row.key("_id"))
        .run();
      expect({
        values: Number([...(values?.values() ?? [])][0]),
        warnings: Number(counted?.get("w")),
        zeros: zeros.sort(),
      }).to.deep.equal({ values: 3, warnings: 0, zeros: ["0", "1"] });
    } finally {
      held.release();
    }
  });
});
