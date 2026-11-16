/** A JSON number as a sign, its decimal digits with no leading zero, and a power of ten. */
export interface Decimal {
  readonly negative: boolean;
  readonly digits: string;
  readonly exponent: number;
}

/** A JSON value whose numbers are values, not yet written as text. */
export type Template =
  | { readonly kind: "null" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "number"; readonly value: Decimal }
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "array"; readonly items: readonly Template[] }
  | {
      readonly kind: "object";
      readonly members: readonly (readonly [string, Template])[];
    };

/** A JSON value as written: each number keeps the text a writer spelled it with. */
export type Json =
  | { readonly kind: "null" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "number"; readonly text: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "array"; readonly items: readonly Json[] }
  | {
      readonly kind: "object";
      readonly members: readonly (readonly [string, Json])[];
    };

/** A value as a row stores it: the JSON it holds and its text, or neither for an absent key. */
export interface Written {
  readonly json: Json | undefined;
  readonly text: string | undefined;
}

/** What MySQL reads a number as: an integer of 64 bits exactly, or a double. */
export type Magnitude =
  | { readonly kind: "integer"; readonly value: bigint }
  | { readonly kind: "double"; readonly value: number };

const SIGNED_MIN = -(2n ** 63n);
const UNSIGNED_MAX = 2n ** 64n - 1n;
const EXACT_DOUBLES = 2 ** 53;

/**
 * The value MySQL compares a number by: an integer literal from -2^63 to 2^64 - 1 exactly, and any
 * other number as the double it parses to, an integral one by the digits of its shortest decimal.
 */
export function NumberValue(text: string): Magnitude {
  if (/^-?[0-9]+$/.test(text)) {
    const exact = BigInt(text);
    if (exact >= SIGNED_MIN && exact <= UNSIGNED_MAX) {
      return { kind: "integer", value: exact };
    }
  }
  const double = Number(text);
  if (!Number.isInteger(double)) {
    return { kind: "double", value: double };
  }
  const [mantissa = "", exponent = "0"] = double.toString().split("e");
  const [whole = "", fraction = ""] = mantissa.split(".");
  const zeros = "0".repeat(Math.max(0, Number(exponent) - fraction.length));
  return { kind: "integer", value: BigInt(`${whole}${fraction}${zeros}`) };
}

/** Whether a number's magnitude is past 2^53, where an integer and a double can tell apart one value. */
export function IsWideNumber(value: Json | undefined): boolean {
  if (value?.kind !== "number") {
    return false;
  }
  const parsed = NumberValue(value.text);
  const size = parsed.value < 0 ? -parsed.value : parsed.value;
  return size >= EXACT_DOUBLES;
}

/** Whether a container holds, at any depth, a number whose magnitude is past 2^53. */
export function NestsWideNumber(value: Json | undefined): boolean {
  if (value?.kind === "array") {
    return value.items.some(
      (item) => IsWideNumber(item) || NestsWideNumber(item),
    );
  }
  if (value?.kind === "object") {
    return value.members.some(
      ([, member]) => IsWideNumber(member) || NestsWideNumber(member),
    );
  }
  return false;
}

function CompareNumbers(left: string, right: string): number {
  const [l, r] = [NumberValue(left).value, NumberValue(right).value];
  if (l < r) {
    return -1;
  }
  return l > r ? 1 : 0;
}

/**
 * The place a value takes in MySQL's JSON order, lowest first: an absent key, null, numbers, strings,
 * objects, arrays, false, true.
 */
export function Rank(value: Json | undefined): number {
  if (value === undefined) {
    return 0;
  }
  switch (value.kind) {
    case "null":
      return 1;
    case "number":
      return 2;
    case "string":
      return 3;
    case "object":
      return 4;
    case "array":
      return 5;
    case "boolean":
      return value.value ? 7 : 6;
  }
}

function Bytes(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

/**
 * Whether MySQL's JSON `=` finds two values equal: the same type, the same numbers by value, the
 * same strings, arrays and objects member by member.
 */
export function Equal(
  left: Json | undefined,
  right: Json | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  if (Rank(left) !== Rank(right)) {
    return false;
  }
  if (left.kind === "number" && right.kind === "number") {
    return CompareNumbers(left.text, right.text) === 0;
  }
  if (left.kind === "string" && right.kind === "string") {
    return Bytes(left.value).equals(Bytes(right.value));
  }
  if (left.kind === "array" && right.kind === "array") {
    return (
      left.items.length === right.items.length &&
      left.items.every((item, at) => Equal(item, right.items[at]))
    );
  }
  if (left.kind === "object" && right.kind === "object") {
    const others = new Map(right.members);
    return (
      left.members.length === right.members.length &&
      left.members.every(([key, item]) => {
        const other = others.get(key);
        return other !== undefined && Equal(item, other);
      })
    );
  }
  return true;
}

/**
 * How MySQL orders two values: below 0, 0 or above 0, or `undefined` where MySQL's order is not
 * the module's contract, two objects or two arrays that are not equal.
 */
export function Order(
  left: Json | undefined,
  right: Json | undefined,
): number | undefined {
  const ranks = Rank(left) - Rank(right);
  if (ranks !== 0) {
    return Math.sign(ranks);
  }
  if (left?.kind === "number" && right?.kind === "number") {
    return CompareNumbers(left.text, right.text);
  }
  if (left?.kind === "string" && right?.kind === "string") {
    return Math.sign(Bytes(left.value).compare(Bytes(right.value)));
  }
  if (left?.kind === "array" || left?.kind === "object") {
    return Equal(left, right) ? 0 : undefined;
  }
  return 0;
}

/** A text that two values share exactly when {@link Equal} finds them equal. */
export function ClassOf(value: Json | undefined): string {
  if (value === undefined) {
    return "absent";
  }
  switch (value.kind) {
    case "null":
      return "null";
    case "boolean":
      return String(value.value);
    case "number": {
      const parsed = NumberValue(value.text);
      return `${parsed.kind[0]}${parsed.value}`;
    }
    case "string":
      return `s${Bytes(value.value).toString("hex")}`;
    case "array":
      return `[${value.items.map(ClassOf).join(",")}]`;
    case "object":
      return `{${value.members
        .map(
          ([key, member]) => `${Bytes(key).toString("hex")}:${ClassOf(member)}`,
        )
        .sort()
        .join(",")}}`;
  }
}
