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

  it("read text with a zone offset as the instant new Date reads, before 1970 as after it", async () => {
    const texts = [
      "1500-03-01T12:00:00+02:00",
      "1960-01-01T00:00:00+02:00",
      "1960-01-01T00:00:00-05:30",
      "1969-12-31T23:00:00+01:00",
      "2024-06-01T12:00:00+02:00",
      "2200-06-01T00:00:00+02:00",
    ];
    const read = await First(
      table
        .rows()
        .map(() =>
          texts.map((text) => ValueProxy.constant<string | Date>(text).epoch()),
        ),
    );
    assert.deepEqual(
      read,
      texts.map((text) => Date.parse(text) / 1000),
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

/** A hyphen beside a class escape inside a class, which JavaScript reads as a hyphen and never as a range. */
const HYPHEN_CASES: readonly PatternCase[] = [
  ["a", "^[\\w-.]$"],
  [".", "^[\\w-.]$"],
  ["-", "^[\\w-.]$"],
  ["-", "^[\\w-]$"],
  ["-", "^[-\\w]$"],
  [" ", "^[\\s-.]$"],
  ["-", "^[\\s-.]$"],
  ["/", "^[\\d-/]$"],
  ["a", "^[\\W-.]$"],
  ["-", "^[\\W-.]$"],
  ["a", "^[\\w-\\d]$"],
  ["-", "^[\\w-\\d]$"],
  ["`", "^[\\w-a]$"],
  ["-", "^[\\w-a]$"],
  ["@", "^[.-\\w]$"],
  ["-", "^[.-\\w]$"],
  ["Q", "^[a-c\\d-z]$"],
  ["-", "^[a-c\\d-z]$"],
  ["b", "^[\\d-a-f]$"],
  ["5", "^[\\s-0-9]+$"],
  ["5", "^[\\s-.-9]$"],
  ["b", "^[\\d-a-z]$"],
  ["q", "^[\\d-a-z]$"],
  ["a", "^[\\d-a-z]$"],
  ["b", "^[\\s-a-c]$"],
  ["#", "^[\\w-!-%]$"],
  ["5", "^[\\w-!-%]$"],
  ["b", "^[.-\\w-a-c]$"],
  [".", "^[\\d--e]$"],
  ["a", "^[\\w--0]$"],
  [".", "^[--e]$"],
  ["-", "^[---]$"],
  ["a@b-c.com", "^[\\w-.]+@([\\w-]+\\.)+[\\w-]{2,4}$"],
  ["a.b+c@d.co", "^[\\w.+-]+@[\\w-]+\\.[\\w.-]+$"],
  ["my-host.example", "^[\\w-]+(\\.[\\w-]+)*$"],
];

/** The members a class of the fuzz below is built from: class escapes, hyphens and range ends. */
const CLASS_PARTS = ["\\d", "\\w", "\\s", "\\D", "-", ".", "a", "e", "0"];

/** Texts on every side of those members: digits, letters, a space, a hyphen, a dot and punctuation. */
const CLASS_TEXTS = [
  "-",
  ".",
  "/",
  "0",
  "5",
  "a",
  "b",
  "e",
  "f",
  "_",
  " ",
  "#",
];

/** Whether JavaScript accepts a pattern, which it does not for a range whose ends are out of order. */
function IsPattern(pattern: string): boolean {
  try {
    RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/** Every class of three members, and every fifth of four, that JavaScript accepts, against each text. */
function ClassFuzzCases(): PatternCase[] {
  const bodies = (length: number): string[] =>
    length === 0
      ? [""]
      : bodies(length - 1).flatMap((body) =>
          CLASS_PARTS.map((part) => body + part),
        );
  const patterns = [
    ...bodies(3),
    ...bodies(4).filter((_, index) => index % 5 === 0),
  ]
    .map((body) => `^[${body}]$`)
    .filter(IsPattern);
  return patterns.flatMap((pattern) =>
    CLASS_TEXTS.map((text): PatternCase => [text, pattern]),
  );
}

/** A text as its code points, which names an invisible or a look-alike character unambiguously. */
function CodePoints(text: string): string {
  return Array.from(
    text,
    (char) =>
      `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`,
  ).join(" ");
}

/** How many cases one statement matches at once. */
const CASES_PER_STATEMENT = 200;

/**
 * What the module answers for each case, in one statement per batch. A batch the server refuses is
 * matched again one case per statement, so a pattern it cannot read is named alone.
 */
async function Answers(batch: readonly PatternCase[]): Promise<unknown[]> {
  const matches = () =>
    batch.map(([text, pattern]) => ValueProxy.constant(text).match(pattern));
  const together = await First(table.rows().map(matches)).catch(
    () => undefined,
  );
  if (together) {
    return together;
  }
  const alone: unknown[] = [];
  for (const [text, pattern] of batch) {
    alone.push(
      await First(
        table.rows().map(() => ValueProxy.constant(text).match(pattern)),
      ).catch((err: unknown) => String(err)),
    );
  }
  return alone;
}

/** The cases whose literal pattern the module matches otherwise than JavaScript's `RegExp` does, or refuses. */
async function Mismatches(cases: readonly PatternCase[]): Promise<string[]> {
  const mismatches: string[] = [];
  for (let first = 0; first < cases.length; first += CASES_PER_STATEMENT) {
    const batch = cases.slice(first, first + CASES_PER_STATEMENT);
    const answers = await Answers(batch);
    batch.forEach(([text, pattern], index) => {
      const answer = answers[index];
      if (answer !== new RegExp(pattern).test(text)) {
        mismatches.push(
          `${CodePoints(text)} against ${pattern}: ${String(answer)}`,
        );
      }
    });
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

  it("match a hyphen beside a class escape in a class as a hyphen, as JavaScript does", async () => {
    assert.deepEqual(await Mismatches(HYPHEN_CASES), []);
  });

  it("match every class of class escapes, hyphens and range ends as JavaScript does", async () => {
    assert.deepEqual(await Mismatches(ClassFuzzCases()), []);
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
