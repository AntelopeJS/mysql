import type { Decimal, Json, Template, Written } from "./json-model";

/** How far a writer may vary the text of one value: engines that keep a document as written read each variation as another value. */
export interface Spelling {
  readonly escapes: boolean;
  readonly keyOrder: boolean;
}

const SIGNED_MIN = -(2n ** 63n);
const UNSIGNED_MAX = 2n ** 64n - 1n;
const EXACT_SIGNIFICAND = 15;
const EXACT_POWER = 22;
const INTEGER_DIGITS = 19;
const MAX_PLAIN_PLACES = 30;
const MAX_TRAILING_ZEROS = 3;
const MAX_FRACTION_DIGITS = 12;
const HEX = 16;
const HEX_DIGITS = 4;
const ASCII_END = 0x80;
const CONTROL_END = 0x20;
const ASTRAL_BASE = 0x10000;
const BMP_END = 0xffff;
const HIGH_BASE = 0xd800;
const LOW_BASE = 0xdc00;
const SURROGATE_SHIFT = 10;
const SURROGATE_MASK = 0x3ff;
const ESCAPE_SHARE = 0.5;
const RANDOM_ESCAPE_SHARE = 0.2;
const OMIT_POWER_SHARE = 0.5;
const PRNG_STEP = 0x6d2b79f5;
const PRNG_SHIFT = 15;
const PRNG_MIX = 7;
const PRNG_OR = 61;
const PRNG_FLOAT = 4_294_967_296;

/** A source of numbers in [0, 1) that a seed fixes, so a draw replays. */
export function Random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + PRNG_STEP) >>> 0;
    let mixed = Math.imul(state ^ (state >>> PRNG_SHIFT), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> PRNG_MIX), mixed | PRNG_OR);
    return ((mixed ^ (mixed >>> (PRNG_SHIFT - 1))) >>> 0) / PRNG_FLOAT;
  };
}

/** One of `choices`, as `next` picks. */
export function Pick<T>(next: () => number, choices: readonly T[]): T {
  return choices[Math.floor(next() * choices.length)];
}

/** A whole number from 0 up to, not including, `bound`. */
export function Below(next: () => number, bound: number): number {
  return Math.floor(next() * bound);
}

function Plain(digits: string, exponent: number): string | undefined {
  if (digits === "0") {
    return "0";
  }
  if (exponent >= 0 && exponent <= MAX_PLAIN_PLACES) {
    return `${digits}${"0".repeat(exponent)}`;
  }
  const places = -exponent;
  if (exponent < 0 && places <= MAX_PLAIN_PLACES) {
    if (digits.length > places) {
      return `${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places)}`;
    }
    return `0.${"0".repeat(places - digits.length)}${digits}`;
  }
  return undefined;
}

/**
 * Whether MySQL's JSON parser reads `text` as the double nearest to it, as MariaDB's does: an
 * integer literal of 64 bits, a significand of up to 15 digits scaled by up to 10^22 (one rounding),
 * or one of up to 19 digits with no scale. A longer significand or a larger scale can leave MySQL
 * one step from the nearest double, which is the parser's limit and not the module's.
 */
function ParsesExactly(text: string): boolean {
  const match = /^-?([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(text);
  if (match === null) {
    return false;
  }
  const [, whole = "", fraction = "", power] = match;
  if (power === undefined && fraction === "") {
    const exact = BigInt(text);
    return exact >= SIGNED_MIN && exact <= UNSIGNED_MAX;
  }
  const significand = `${whole}${fraction}`.replace(/^0+/, "");
  const scale = Number(power ?? 0) - fraction.length;
  if (significand === "") {
    return true;
  }
  return (
    (significand.length <= EXACT_SIGNIFICAND &&
      Math.abs(scale) <= EXACT_POWER) ||
    (fraction === "" && scale === 0 && significand.length <= INTEGER_DIGITS)
  );
}

/** Writes a number's digits and power of ten as one of the spellings JSON allows. */
function SpellDecimal(value: Decimal, next: () => number): string {
  const zeros =
    value.digits === "0" || value.digits.length > MAX_FRACTION_DIGITS
      ? 0
      : Below(next, MAX_TRAILING_ZEROS + 1);
  const digits = `${value.digits}${"0".repeat(zeros)}`;
  const exponent = value.exponent - zeros;
  const sign = value.negative ? "-" : "";
  const e = Pick(next, ["e", "E"]);
  const plus = Pick(next, ["", "+"]);
  const power = (at: number) => `${e}${at < 0 ? "-" : plus}${Math.abs(at)}`;
  const plain = Plain(digits, exponent);
  const at = Below(next, digits.length + 1);
  const shifted = exponent + digits.length - at;
  const fraction = digits.slice(at);
  const bare = shifted === 0 && next() < OMIT_POWER_SHARE;
  const candidates = [
    plain === undefined ? undefined : `${sign}${plain}`,
    plain === undefined
      ? undefined
      : `${sign}${plain.includes(".") ? plain : `${plain}.0`}`,
    `${sign}${at === 0 ? "0" : digits.slice(0, at)}.${fraction === "" ? "0" : fraction}${bare ? "" : power(shifted)}`,
    `${sign}${digits}${power(exponent)}`,
  ];
  const start = Below(next, candidates.length);
  for (let step = 0; step < candidates.length; step += 1) {
    const candidate = candidates[(start + step) % candidates.length];
    if (candidate !== undefined && ParsesExactly(candidate)) {
      return candidate;
    }
  }
  throw new Error(`no spelling of ${sign}${digits}e${exponent} parses exactly`);
}

function Unit(code: number): string {
  return `\\u${code.toString(HEX).padStart(HEX_DIGITS, "0")}`;
}

/** Writes a string as JSON, escaping a character as `\uXXXX` where `escapes` allows and `next` chooses. */
function SpellString(
  value: string,
  next: () => number,
  escapes: boolean,
): string {
  const spelled = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    const encode =
      escapes &&
      (code >= ASCII_END ||
        code < CONTROL_END ||
        next() < RANDOM_ESCAPE_SHARE) &&
      next() < ESCAPE_SHARE;
    if (!encode) {
      return JSON.stringify(character).slice(1, -1);
    }
    if (code > BMP_END) {
      const offset = code - ASTRAL_BASE;
      return `${Unit(HIGH_BASE + (offset >> SURROGATE_SHIFT))}${Unit(LOW_BASE + (offset & SURROGATE_MASK))}`;
    }
    return Unit(code);
  });
  return `"${spelled.join("")}"`;
}

function ByLengthThenBytes(left: string, right: string): number {
  const [l, r] = [Buffer.from(left, "utf8"), Buffer.from(right, "utf8")];
  return l.length - r.length || l.compare(r);
}

interface Spelt {
  readonly json: Json;
  readonly text: string;
}

/**
 * Writes a template as JSON, spelling each number, and each string and the order of each object's
 * keys where `spelling` allows, as `seed` chooses.
 */
export function Spell(
  template: Template,
  seed: number,
  spelling: Spelling,
): Written {
  const next = Random(seed);
  const write = (value: Template): Spelt => {
    switch (value.kind) {
      case "null":
        return { json: value, text: "null" };
      case "boolean":
        return { json: value, text: String(value.value) };
      case "number": {
        const text = SpellDecimal(value.value, next);
        return { json: { kind: "number", text }, text };
      }
      case "literal":
        return {
          json: { kind: "number", text: value.text },
          text: value.text,
        };
      case "string":
        return {
          json: value,
          text: SpellString(value.value, next, spelling.escapes),
        };
      case "array": {
        const items = value.items.map(write);
        return {
          json: { kind: "array", items: items.map((item) => item.json) },
          text: `[${items.map((item) => item.text).join(",")}]`,
        };
      }
      case "object": {
        const order = [...value.members];
        if (!spelling.keyOrder) {
          order.sort(([left], [right]) => ByLengthThenBytes(left, right));
        } else {
          for (let at = order.length - 1; at > 0; at -= 1) {
            const other = Below(next, at + 1);
            [order[at], order[other]] = [order[other], order[at]];
          }
        }
        const members = order.map(([key, member]) => ({
          key,
          written: write(member),
          spelled: SpellString(key, next, spelling.escapes),
        }));
        return {
          json: {
            kind: "object",
            members: members.map(({ key, written }) => [key, written.json]),
          },
          text: `{${members.map(({ spelled, written }) => `${spelled}:${written.text}`).join(",")}}`,
        };
      }
    }
  };
  return write(template);
}
