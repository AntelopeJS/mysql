import { Below, Pick, Random } from "./json-spell";

/** A JSON value of the kinds a key's member holds in these documents. */
export type KeyValue = string | boolean | null | KeyValue[] | KeyObject;

/** A JSON object read as a reader that keeps the last member of a repeated key reads it. */
export interface KeyObject {
  [key: string]: KeyValue;
}

/** A constant a merge takes: an object of scalars. */
export interface Operand {
  [key: string]: string | boolean | null;
}

/** An object as its writer spelled it, and what a reader that keeps the last member of a repeated key sees. */
export interface KeyedObject {
  readonly text: string;
  readonly value: KeyObject;
  readonly repeats: boolean;
  readonly depth: number;
}

/** Whether the engine that stores the text as written reads a key's ASCII escapes as MySQL decodes them. */
export interface KeySpelling {
  readonly escapeAscii: boolean;
}

/** The key each level holds the next level under. */
export const CHAIN_KEY = "é";

const PLAIN_KEYS = ["a", "b", "k", "a b", "x1", ""] as const;
const OTHER_KEYS = [
  "é",
  "ü",
  "日本",
  "\u{1F600}",
  "<b>",
  "a/b",
  'q"r',
  "back\\slash",
  "nl\n",
  "tab\there",
  "bell\u0007",
  "vt\u000b",
  "\u0001",
  "\u001f",
  "é",
] as const;
const LEAVES = [
  "x",
  "g",
  "first",
  "last",
  "é",
  "",
  "a\u000bb",
  true,
  false,
  null,
] as const;
const SCALARS = ["x", "g", "é", "", true, false, null] as const;
const HEX = 16;
const HEX_DIGITS = 4;
const MAX_MEMBERS = 3;
const REPEAT_SHARE = 0.4;
const DEEP_REPEAT_SHARE = 0.5;
const PLAIN_SHARE = 0.4;
const ARRAY_SHARE = 0.15;
const COIN = 0.5;
const CONTROL_END = 0x20;
const ASCII_END = 0x7f;
const BMP_END = 0xffff;
const ASTRAL_BASE = 0x10000;
const HIGH_BASE = 0xd800;
const LOW_BASE = 0xdc00;
const SURROGATE_SHIFT = 10;
const SURROGATE_MASK = 0x3ff;

function Unit(code: number, upper: boolean): string {
  const digits = code.toString(HEX).padStart(HEX_DIGITS, "0");
  return `\\u${upper ? digits.toUpperCase() : digits}`;
}

function SpellCharacter(
  character: string,
  next: () => number,
  spelling: KeySpelling,
): string {
  const code = character.codePointAt(0) ?? 0;
  const upper = next() < COIN;
  const escape = next() < COIN;
  if (character === '"' || character === "\\") {
    return `\\${character}`;
  }
  if (character === "/") {
    return escape ? "\\/" : "/";
  }
  if (code < CONTROL_END) {
    const short = JSON.stringify(character).slice(1, -1);
    return escape || short.startsWith("\\u") ? Unit(code, upper) : short;
  }
  if (code <= ASCII_END) {
    return escape && spelling.escapeAscii ? Unit(code, upper) : character;
  }
  if (!escape) {
    return character;
  }
  if (code > BMP_END) {
    const offset = code - ASTRAL_BASE;
    const high = Unit(HIGH_BASE + (offset >> SURROGATE_SHIFT), upper);
    return `${high}${Unit(LOW_BASE + (offset & SURROGATE_MASK), upper)}`;
  }
  return Unit(code, upper);
}

/** A key as JSON text: a control character, a quote and a backslash escaped as JSON requires, and anything else literal or as `\uXXXX`, as `next` chooses. */
function SpellKey(
  key: string,
  next: () => number,
  spelling: KeySpelling,
): string {
  const parts = Array.from(key, (character) =>
    SpellCharacter(character, next, spelling),
  );
  return `"${parts.join("")}"`;
}

/** A value and the text that writes it. */
interface Spelled {
  readonly text: string;
  readonly value: KeyValue;
}

interface Member {
  readonly key: string;
  readonly text: string;
  readonly value: KeyValue;
  readonly valueText: string;
}

function Leaf(next: () => number): Spelled {
  const atom = Pick(next, LEAVES);
  if (next() < ARRAY_SHARE) {
    return { text: `[${JSON.stringify(atom)}]`, value: [atom] };
  }
  return { text: JSON.stringify(atom), value: atom };
}

function DrawKey(next: () => number): string {
  return next() < PLAIN_SHARE ? Pick(next, PLAIN_KEYS) : Pick(next, OTHER_KEYS);
}

interface Built {
  readonly text: string;
  readonly value: KeyObject;
  readonly repeats: boolean;
}

function Level(
  next: () => number,
  spelling: KeySpelling,
  below: number,
  repeatHere: boolean,
): Built {
  const keys = new Set<string>();
  const count = 1 + Below(next, MAX_MEMBERS);
  while (keys.size < count) {
    keys.add(DrawKey(next));
  }
  keys.delete(CHAIN_KEY);
  if (keys.size === 0) {
    keys.add(PLAIN_KEYS[0]);
  }
  const written: Member[] = Array.from(keys, (key) => {
    const leaf = Leaf(next);
    return {
      key,
      text: SpellKey(key, next, spelling),
      value: leaf.value,
      valueText: leaf.text,
    };
  });
  let repeats = false;
  if (below > 0) {
    const inner = Level(
      next,
      spelling,
      below - 1,
      below === 1 && next() < DEEP_REPEAT_SHARE,
    );
    repeats = inner.repeats;
    written.push({
      key: CHAIN_KEY,
      text: SpellKey(CHAIN_KEY, next, spelling),
      value: inner.value,
      valueText: inner.text,
    });
  }
  if (repeatHere || next() < REPEAT_SHARE) {
    const source = Pick(next, written);
    const leaf = Leaf(next);
    written.splice(Below(next, written.length + 1), 0, {
      key: source.key,
      text: SpellKey(source.key, next, spelling),
      value: leaf.value,
      valueText: leaf.text,
    });
    repeats = true;
  }
  const value: KeyObject = {};
  for (const member of written) {
    value[member.key] = member.value;
  }
  return {
    text: `{${written.map(({ text, valueText }) => `${text}:${valueText}`).join(",")}}`,
    value,
    repeats,
  };
}

/** Draws an object that nests `levels` objects below its first, with keys escaped, control characters, Unicode and keys written twice. */
export function DrawKeyedObject(
  seed: number,
  levels: number,
  spelling: KeySpelling,
): KeyedObject {
  const built = Level(Random(seed), spelling, levels, false);
  return { ...built, depth: levels + 1 };
}

/** A constant operand: an object whose keys come from the same atoms and whose values are scalars. */
export function DrawOperand(seed: number): Operand {
  const next = Random(seed);
  const operand: Operand = {};
  const count = Below(next, MAX_MEMBERS + 1);
  for (let at = 0; at < count; at += 1) {
    operand[DrawKey(next)] = Pick(next, SCALARS);
  }
  return operand;
}
