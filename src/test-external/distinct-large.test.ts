import { expect } from "chai";
import type { Schema } from "@antelopejs/interface-database/schema";

import { Read } from "../connection";
import { param, sql } from "../statement";
import { NativeWrite, RegisterSales, type SalesTables } from "./sales";

/** The bytes of JSON text each document holds. */
const DOCUMENT_BYTES = 400 * 1024;

/**
 * The longest a dedup may take per row it reads, of a document whose numbers have at most 15 digits
 * and no exponent. A respell quadratic in the text took over 1.1 s a row on an idle host, and the
 * linear one up to 250 ms a row beside 4 busy loops per CPU.
 */
const MS_PER_ROW = 400;

/** The runs a dedup gets to come in under its budget, since a busy host only adds to its time. */
const ATTEMPTS = 3;

/** How many times `part` and a comma fill {@link DOCUMENT_BYTES}. */
function Fitting(part: string): number {
  return Math.ceil(DOCUMENT_BYTES / (part.length + 1));
}

const KEYS = Array.from(
  { length: Fitting('"k00000":12.0') },
  (_, index) => `k${String(index).padStart(5, "0")}`,
);
const ELEMENTS = Fitting("12.0");
const RECORDS = Fitting('{"a":12.0}');

/**
 * An array, an object and an array of objects, each of `12.0` spelled as another writer stores it,
 * whose dedup respells every number nested in it.
 */
const DOCUMENTS = [
  `[${Array.from({ length: ELEMENTS }, () => "12.0").join(",")}]`,
  `{${KEYS.map((key) => `"${key}":12.0`).join(",")}}`,
  `[${Array.from({ length: RECORDS }, () => '{"a":12.0}').join(",")}]`,
];

const EXPECTED = [
  Array.from({ length: ELEMENTS }, () => 12),
  Object.fromEntries(KEYS.map((key) => [key, 12])),
  Array.from({ length: RECORDS }, () => ({ a: 12 })),
];

const CODES = "^jl";

let sales: Schema<SalesTables>;

function Large() {
  return sales
    .instance()
    .table("w_accounts")
    .filter((row) => row.key("code").match(CODES));
}

/** The sort buffer of the pooled connection a read takes, which the pool hands out last in, first out. */
async function SortBuffer(): Promise<number> {
  const [row] = await Read(sql`SELECT @@session.sort_buffer_size AS value`);
  return Number(row.get("value"));
}

function Sorted(values: readonly unknown[] | undefined): unknown[] {
  return [...(values ?? [])].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

/** The result of `run` and its fastest time over up to {@link ATTEMPTS} runs, stopping at one in `budget`. */
async function Fastest<T>(
  run: () => Promise<T>,
  budget: number,
): Promise<[T, number]> {
  let [result, fastest] = await Timed(run);
  for (let attempt = 1; attempt < ATTEMPTS && fastest >= budget; attempt++) {
    const [next, ms] = await Timed(run);
    result = next;
    fastest = Math.min(fastest, ms);
  }
  return [result, fastest];
}

async function Timed<T>(run: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const result = await run();
  return [result, performance.now() - started];
}

describe("a dedup of large external JSON documents", function () {
  this.timeout(120_000);

  before(async () => {
    sales = await RegisterSales();
    await NativeWrite(sql`DELETE FROM sales.w_accounts WHERE code LIKE 'jl%'`);
    for (const [index, text] of DOCUMENTS.entries()) {
      await NativeWrite(
        sql`INSERT INTO sales.w_accounts (code, raw) VALUES (${param(`jl${index}`)}, ${param(text)})`,
      );
    }
  });

  after(async () => {
    await NativeWrite(sql`DELETE FROM sales.w_accounts WHERE code LIKE 'jl%'`);
  });

  it("keeps one value per document at the top in under 0.4 s a row", async () => {
    const budget = MS_PER_ROW * DOCUMENTS.length;
    const [values, ms] = await Fastest(
      () => Large().distinct("raw").run(),
      budget,
    );
    expect(Sorted(values)).to.deep.equal(Sorted(EXPECTED));
    expect(ms).to.be.below(budget);
  });

  it("keeps one value per document in a group read by a cursor, and gives back its sort buffer", async () => {
    const before = await SortBuffer();
    const query = Large().group("status", (stream) => stream.distinct("raw"));
    const groups = [];
    for await (const group of query) {
      groups.push(group);
    }
    expect(groups).to.have.length(1);
    expect(Sorted(groups[0])).to.deep.equal(Sorted(EXPECTED));
    expect(await SortBuffer()).to.equal(before);
  });

  it("keeps one value per document in a group in under 0.4 s a row", async () => {
    const budget = MS_PER_ROW * DOCUMENTS.length;
    const [groups, ms] = await Fastest(
      () =>
        Large()
          .group("status", (stream) => stream.distinct("raw"))
          .run(),
      budget,
    );
    expect(Sorted(groups[0])).to.deep.equal(Sorted(EXPECTED));
    expect(ms).to.be.below(budget);
  });
});
