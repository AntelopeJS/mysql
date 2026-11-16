import type { Decimal, Template } from "./json-model";
import { Below, Pick } from "./json-spell";

const INTEGER_DIGITS = 19;
const MAX_DIGITS = 12;
const MIN_EXPONENT = -19;
const MAX_EXPONENT = 22;
const MAX_ITEMS = 3;
const MAX_DEPTH = 4;
const MIN_NEST = 5;
const MAX_NEST = 24;
const NESTED_SHARE = 0.1;
const ABSENT_SHARE = 0.12;
const VETTED_SHARE = 0.4;
const EDGE_SHARE = 0.5;
const RANDOM_SHARE = 0.8;
const NEGATIVE_SHARE = 0.5;
const MAX_SMALL_EXPONENT = 3;

const EDGE_NUMBERS: readonly Decimal[] = [
  ["9223372036854775807", 0],
  ["9223372036854775808", 0],
  ["18446744073709551615", 0],
  ["9007199254740993", 0],
  ["9007199254740992", 0],
  ["1", 19],
  ["1", 20],
  ["1", 21],
  ["1", 22],
  ["1", 0],
  ["1", -1],
  ["5", -1],
  ["0", 0],
].flatMap(([digits, exponent]) =>
  [false, true]
    .filter((negative) => !negative || String(digits).length <= INTEGER_DIGITS)
    .map((negative) => ({
      negative,
      digits: String(digits),
      exponent: Number(exponent),
    })),
);

/**
 * Spellings of numbers at the edges of the integer and double ranges, whose value MySQL and MariaDB
 * parse alike and which `src/test/equal-numbers.test.ts` checks on every engine.
 */
const VETTED_NUMBERS = [
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

const SMALL_DIGITS = ["1", "5", "25", "125", "10", "3"] as const;
const STRING_ATOMS = [
  "",
  "0",
  "1",
  "null",
  "true",
  "a",
  "b",
  "é",
  "é",
  "￿",
  "\u{10000}",
  "a b",
  "\n",
  "\u0001",
] as const;
const KEY_ATOMS = ["a", "b", "é", "k", "", "0", "a b", "null"] as const;
const REPEATED = ["x", "é", "\u{10000}"] as const;
const REPEAT_COUNTS = [0, 100, 300, 600, 1100] as const;
const TAILS = ["", "a", "b", "é", "\u{10000}", "￿"] as const;
const STRING_ATOM_SHARE = 0.7;
const LEAF_SHARE = 0.55;
const ARRAY_SHARE = 0.78;
const NULL_SHARE = 0.1;
const BOOLEAN_SHARE = 0.2;
const NUMBER_SHARE = 0.65;
const DECIMAL_DIGIT = 10;
const COIN = 0.5;

/** One decimal: an edge of the integer and double ranges, a random run of digits, or a small one. */
function DrawDecimal(next: () => number): Decimal {
  const kind = next();
  const negative = next() < NEGATIVE_SHARE;
  if (kind < EDGE_SHARE) {
    return Pick(next, EDGE_NUMBERS);
  }
  if (kind < RANDOM_SHARE) {
    const length = 1 + Below(next, MAX_DIGITS);
    const digits = Array.from({ length }, () => Below(next, DECIMAL_DIGIT));
    return {
      negative,
      digits: digits.join("").replace(/^0+(?=[0-9])/, ""),
      exponent: MIN_EXPONENT + Below(next, MAX_EXPONENT - MIN_EXPONENT + 1),
    };
  }
  return {
    negative,
    digits: Pick(next, SMALL_DIGITS),
    exponent: Below(next, 2 * MAX_SMALL_EXPONENT + 1) - MAX_SMALL_EXPONENT,
  };
}

function DrawNumber(next: () => number): Template {
  if (next() < VETTED_SHARE) {
    return { kind: "literal", text: Pick(next, VETTED_NUMBERS) };
  }
  return { kind: "number", value: DrawDecimal(next) };
}

function DrawString(next: () => number): string {
  if (next() < STRING_ATOM_SHARE) {
    return Pick(next, STRING_ATOMS);
  }
  const unit = Pick(next, REPEATED);
  return `${unit.repeat(Pick(next, REPEAT_COUNTS))}${Pick(next, TAILS)}`;
}

function DrawLeaf(next: () => number): Template {
  const kind = next();
  if (kind < NULL_SHARE) {
    return { kind: "null" };
  }
  if (kind < BOOLEAN_SHARE) {
    return { kind: "boolean", value: next() < COIN };
  }
  if (kind < NUMBER_SHARE) {
    return DrawNumber(next);
  }
  return { kind: "string", value: DrawString(next) };
}

function DrawTree(next: () => number, depth: number): Template {
  const kind = next();
  if (depth >= MAX_DEPTH || kind < LEAF_SHARE) {
    return DrawLeaf(next);
  }
  const length = Below(next, MAX_ITEMS + 1);
  if (kind < ARRAY_SHARE) {
    return {
      kind: "array",
      items: Array.from({ length }, () => DrawTree(next, depth + 1)),
    };
  }
  const keys = new Set<string>();
  for (let at = 0; at < length; at += 1) {
    keys.add(Pick(next, KEY_ATOMS));
  }
  return {
    kind: "object",
    members: Array.from(keys, (key) => [key, DrawTree(next, depth + 1)]),
  };
}

/** A value wrapped in one array or object per level, as deep as a document nests in practice. */
function DrawNested(next: () => number): Template {
  const levels = MIN_NEST + Below(next, MAX_NEST - MIN_NEST + 1);
  let value = DrawLeaf(next);
  for (let level = 0; level < levels; level += 1) {
    value =
      next() < COIN
        ? { kind: "array", items: [value] }
        : { kind: "object", members: [["k", value]] };
  }
  return value;
}

/** A JSON value, as a mix of scalars, containers and chains of one-member containers. */
export function DrawTemplate(next: () => number): Template {
  return next() < NESTED_SHARE ? DrawNested(next) : DrawTree(next, 0);
}

/** A value the key may lack: `undefined` is an absent key. */
export function DrawMaybeTemplate(next: () => number): Template | undefined {
  return next() < ABSENT_SHARE ? undefined : DrawTemplate(next);
}
