import assert from "node:assert/strict";
import { ValueProxy } from "@antelopejs/interface-database";

import { First, ValueStageTable } from "./value-stage-table";

const table = ValueStageTable("value-stages-scalar");

const INT32_OPERANDS: readonly (readonly [number, number])[] = [
  [5, 3],
  [-1, 5],
  [2 ** 31, 1],
  [-(2 ** 31), -1],
  [4294967295, 1],
  [1e10, 3],
  [-7.9, 3.2],
  [2 ** 53, 7],
  [1e300, 1],
  [-6, 33],
  [-8, 1],
  [0, 31],
];

async function Bitwise(left: number, right: number) {
  return First(
    table.rows().map(() => ({
      and: ValueProxy.constant(left).band(right),
      or: ValueProxy.constant(left).bor(right),
      xor: ValueProxy.constant(left).bxor(right),
      not: ValueProxy.constant(left).bnot(),
      left: ValueProxy.constant(left).blshift(right),
      right: ValueProxy.constant(left).brshift(right),
      signed: ValueProxy.constant(left).brshiftPreserveSign(right),
    })),
  );
}

function Expected(left: number, right: number) {
  return {
    and: left & right,
    or: left | right,
    xor: left ^ right,
    not: ~left,
    left: left << right,
    right: left >>> right,
    signed: left >> right,
  };
}

describe("The numeric stages", () => {
  before(() => table.setup());
  after(() => table.teardown());

  it("read an operand as ToInt32 does, wrapped and signed, so each bitwise result is JavaScript's", async () => {
    for (const [left, right] of INT32_OPERANDS) {
      assert.deepEqual(
        await Bitwise(left, right),
        Expected(left, right),
        `${left} and ${right}`,
      );
    }
  });

  it("answer NULL for a zero divisor rather than failing the statement", async () => {
    assert.deepEqual(
      await First(
        table.rows().map(() => ({
          div: ValueProxy.constant(7).div(0),
          mod: ValueProxy.constant(7).mod(0),
        })),
      ),
      { div: null, mod: null },
    );
  });

  it("take the sign of the dividend for mod and round halves up, as JavaScript does", async () => {
    assert.deepEqual(
      await First(
        table.rows().map(() => ({
          mod: ValueProxy.constant(-7).mod(3),
          halfUp: ValueProxy.constant(2.5).round(),
          halfDown: ValueProxy.constant(-2.5).round(),
          ceil: ValueProxy.constant(-1.5).ceil(),
          floor: ValueProxy.constant(-1.5).floor(),
        })),
      ),
      { mod: -1, halfUp: 3, halfDown: -2, ceil: -1, floor: -2 },
    );
  });

  it("move a date by seconds either way and measure the seconds between two", async () => {
    const born = new Date("2023-01-15T13:45:30.250Z");
    assert.deepEqual(
      await First(
        table.rows().map((row) => ({
          later: row.key("bornAt").add(1.5),
          earlier: row.key("bornAt").sub(90),
          elapsed: row.key("bornAt").sub(new Date("2023-01-15T13:44:00.000Z")),
        })),
      ),
      {
        later: new Date(born.getTime() + 1500),
        earlier: new Date(born.getTime() - 90_000),
        elapsed: 90.25,
      },
    );
  });
});

describe("The date stages", () => {
  before(() => table.setup());
  after(() => table.teardown());

  it("read every part in UTC, with the weekday from Monday 1 and the fraction of a second", async () => {
    assert.deepEqual(
      await First(
        table.rows().map((row) => ({
          year: row.key("bornAt").year(),
          month: row.key("bornAt").month(),
          day: row.key("bornAt").day(),
          weekday: row.key("bornAt").dayofweek(),
          dayOfYear: row.key("bornAt").dayofyear(),
          hours: row.key("bornAt").hours(),
          minutes: row.key("bornAt").minutes(),
          seconds: row.key("bornAt").seconds(),
          timeOfDay: row.key("bornAt").timeofday(),
          epoch: row.key("bornAt").epoch(),
        })),
      ),
      {
        year: 2023,
        month: 1,
        day: 15,
        weekday: 7,
        dayOfYear: 15,
        hours: 13,
        minutes: 45,
        seconds: 30.25,
        timeOfDay: 49530.25,
        epoch: 1673790330.25,
      },
    );
  });

  it("read the parts in the zone named, a named one or an offset, and a date part after another stage in UTC again", async () => {
    assert.deepEqual(
      await First(
        table.rows().map((row) => ({
          named: row.key("bornAt").hours("America/New_York"),
          offset: row.key("bornAt").minutes("+05:30"),
          crossesDay: ValueProxy.constant(
            new Date("2023-01-01T02:00:00Z"),
          ).year("America/New_York"),
          utc: row.key("bornAt").hours(),
        })),
      ),
      { named: 8, offset: 15, crossesDay: 2022, utc: 13 },
    );
  });
});

/** A text and a literal pattern, whose match JavaScript's own `RegExp` decides. */
type PatternCase = readonly [string, string];

const ARABIC_THREE = String.fromCodePoint(0x663);
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);
const NO_BREAK_SPACE = String.fromCodePoint(0xa0);
const NEXT_LINE = String.fromCodePoint(0x85);
const VERTICAL_TAB = String.fromCodePoint(0x0b);
const BACKSPACE = String.fromCodePoint(0x08);

const LINE_CASES: readonly PatternCase[] = [
  ["a\nb", "^a.b$"],
  [`a${VERTICAL_TAB}b`, "^a.b$"],
  [`a${NEXT_LINE}b`, "^a.b$"],
  ["a b", "^a.b$"],
  ["abc\n", "c$"],
  ["abc", "c$"],
  ["a b", "\\bb"],
  ["ab", "(?<first>a)b"],
  ["[", "[[]"],
  ["&", "[a&&b]"],
  ["Ab", "^ab$"],
];

const CLASS_ESCAPE_CASES: readonly PatternCase[] = [
  [ARABIC_THREE, "^\\d$"],
  ["7", "^\\d$"],
  [ARABIC_THREE, "^\\D$"],
  ["é", "^\\w$"],
  ["_", "^\\w$"],
  ["é", "^\\W$"],
  [BYTE_ORDER_MARK, "^\\s$"],
  [NEXT_LINE, "^\\s$"],
  [NO_BREAK_SPACE, "^\\s$"],
  [NEXT_LINE, "^\\S$"],
  ["aé", "a\\b"],
  ["ab", "a\\B"],
  [VERTICAL_TAB, "^\\v$"],
  ["\n", "^\\v$"],
  [BACKSPACE, "^[\\b]$"],
  [ARABIC_THREE, "^[\\d]$"],
  ["é", "^[\\w-]$"],
  [ARABIC_THREE, "^[^\\d]$"],
  ["5", "^[\\D]$"],
  [BYTE_ORDER_MARK, "^[\\s]$"],
];

/** A text as its code points, which names an invisible or a look-alike character unambiguously. */
function CodePoints(text: string): string {
  return Array.from(
    text,
    (char) =>
      `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`,
  ).join(" ");
}

/** The cases whose literal pattern the module matches otherwise than JavaScript's `RegExp` does. */
async function Mismatches(cases: readonly PatternCase[]): Promise<string[]> {
  const mismatches: string[] = [];
  for (const [text, pattern] of cases) {
    const matched = await First(
      table.rows().map(() => ValueProxy.constant(text).match(pattern)),
    );
    if (matched !== new RegExp(pattern).test(text)) {
      mismatches.push(`${CodePoints(text)} against ${pattern}`);
    }
  }
  return mismatches;
}

describe("The string stages", () => {
  before(() => table.setup());
  after(() => table.teardown());

  it("change the case of non-ASCII text and count codepoints rather than code units", async () => {
    assert.deepEqual(
      await First(
        table.rows().map(() => ({
          upper: ValueProxy.constant("éa").upcase(),
          lower: ValueProxy.constant("ÉA").downcase(),
          length: ValueProxy.constant("a😀b").strlen(),
        })),
      ),
      { upper: "ÉA", lower: "éa", length: 3 },
    );
  });

  it("match a JavaScript pattern the way JavaScript does: `.` stops at four line terminators, `$` at the end", async () => {
    assert.deepEqual(await Mismatches(LINE_CASES), []);
  });

  it("match a JavaScript class escape the way JavaScript does, with ASCII digits and word characters and its own whitespace", async () => {
    assert.deepEqual(await Mismatches(CLASS_ESCAPE_CASES), []);
  });

  it("match against a pattern the statement computes, bound as it is", async () => {
    assert.equal(
      await First(
        table.rows().map((row) => row.key("name").match(row.key("name"))),
      ),
      true,
    );
  });

  it("concatenate with CONCAT, and answer NULL where an operand is NULL, never an OR", async () => {
    assert.deepEqual(
      await First(
        table.rows().map((row) => ({
          both: row.key("name").concat("!"),
          missing: row.key("name").concat(row.key("name").add(null)),
        })),
      ),
      { both: "ada!", missing: null },
    );
  });

  it("split at every separator as JavaScript does, whatever characters the pieces and the separator hold", async () => {
    const cases: readonly (readonly [string, string | undefined, number?])[] = [
      ["a b c", undefined],
      ["a,b,,c", ","],
      ["", ","],
      [",", ","],
      ["aaa", "aa"],
      ["a\nbnc", "n"],
      ['say "hi"; \\ ok', ";"],
      ['x"y"z', '"'],
      ["a\\b\\c", "\\"],
      ["one, two, three", ", "],
      ["é-ü-😀", "-"],
      ["a,b,c,d", ",", 2],
      ["a,b,c,d", ",", 0],
    ];
    for (const [text, separator, maxSplits] of cases) {
      const expected = text
        .split(separator ?? " ")
        .slice(0, maxSplits ?? undefined);
      assert.deepEqual(
        await First(
          table
            .rows()
            .map(() => ValueProxy.constant(text).split(separator, maxSplits)),
        ),
        expected,
        `${JSON.stringify(text)} by ${JSON.stringify(separator)}`,
      );
    }
  });

  it("split an absent text into NULL", async () => {
    assert.equal(
      await First(
        table.rows().map((row) => row.key("name").add(null).split(",")),
      ),
      null,
    );
  });
});
