import type {
  BindSyntax,
  ConstantJson,
  Int32Syntax,
  RegexSyntax,
  ScalarKind,
  ScalarSyntax,
} from "../sql-types";
import { type Sql, int, join, lit, param, sql } from "../../statement";
import {
  IsBoolean,
  IsNumber,
  IsString,
} from "../../implementations/database/guards";

/** A decimal literal with an optional sign, exponent and surrounding space, and nothing else. */
const NUMERIC_TEXT = lit(
  "^\\s*[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?[0-9]+)?\\s*$",
);

const UTC_DESIGNATOR = /Z$/;
const UTC_OFFSET = "+00:00";
const COMMA = sql`, `;

const CASTS: Record<ScalarKind, (value: Sql) => Sql> = {
  text: (value) => sql`CAST(${value} AS CHAR)`,
  float: (value) => sql`CAST(${value} AS DOUBLE)`,
  timestamp: (value) => sql`CAST(${value} AS DATETIME(6))`,
  bool: (value) => sql`((${value}) <> 0)`,
};

/**
 * Whether JSON text keeps a number on every server version. MySQL 8.4's JSON parser reads some
 * doubles of 17 significant digits as a neighbour, and JSON text spells a negative zero `0`, so of
 * the finite numbers only a safe integer other than -0 survives the text. A number JSON cannot
 * spell is written `null` either way, as `JSON.stringify` writes it.
 */
function IsTextExactNumber(value: number): boolean {
  return (
    !Number.isFinite(value) ||
    (Number.isSafeInteger(value) && !Object.is(value, -0))
  );
}

/** Whether a constant's JSON text keeps every number in it. */
function IsTextExact(value: ConstantJson | undefined): boolean {
  if (
    value === undefined ||
    value === null ||
    IsString(value) ||
    IsBoolean(value)
  ) {
    return true;
  }
  if (IsNumber(value)) {
    return IsTextExactNumber(value);
  }
  const members = Array.isArray(value) ? value : Object.values(value);
  return members.every(IsTextExact);
}

/**
 * A constant as one bound JSON text wherever the text keeps it, so a list of any length is one
 * argument. Any other constant is assembled around each number it holds, bound as a `DOUBLE`, which
 * the server turns into JSON without reading text.
 */
function JsonConstant(value: ConstantJson): Sql {
  if (
    value === null ||
    IsString(value) ||
    IsBoolean(value) ||
    IsTextExact(value)
  ) {
    return sql`CAST(${param(JSON.stringify(value))} AS JSON)`;
  }
  if (IsNumber(value)) {
    return sql`CAST(CAST(${param(value)} AS DOUBLE) AS JSON)`;
  }
  if (Array.isArray(value)) {
    return sql`JSON_ARRAY(${join(value.map(JsonConstant), COMMA)})`;
  }
  const members = Object.entries(value).flatMap(([key, member]) =>
    member === undefined ? [] : [sql`${param(key)}, ${JsonConstant(member)}`],
  );
  return sql`JSON_OBJECT(${join(members, COMMA)})`;
}

/**
 * A number is cast to `DOUBLE`, since the driver sends an integer as a `BIGINT`. A boolean goes as
 * 1 or 0 and is compared with 0, which also marks it a boolean wherever the server turns it into
 * JSON. An instant goes as its ISO text with an explicit `+00:00`: the server reads an offset but
 * not `Z`, which a statement that writes refuses.
 */
const bind: BindSyntax = {
  text: (value) => param(value),
  float: (value) => sql`CAST(${param(value)} AS DOUBLE)`,
  bool: (value) => sql`(${param(value ? 1 : 0)} <> 0)`,
  timestamp: (value) =>
    Number.isNaN(value.getTime())
      ? sql`CAST(NULL AS DATETIME(6))`
      : sql`CAST(${param(value.toISOString().replace(UTC_DESIGNATOR, UTC_OFFSET))} AS DATETIME(6))`,
  json: JsonConstant,
};

const TWO_POW_32 = sql`4294967296`;
const TWO_POW_31 = sql`2147483648`;
const LOW_32_BITS = sql`4294967295`;
const SHIFT_MASK = sql`31`;

/**
 * `ToInt32` over doubles, which hold every integer the arithmetic touches exactly: `MOD` keeps the
 * dividend's sign, so the remainder is lifted by three halves of 2^32 before the second `MOD` and
 * the half is taken off again. The operand is spelled once, however long it is.
 */
function ReadInt32(value: Sql): Sql {
  return sql`CAST(MOD(MOD(TRUNCATE(${value}, 0), ${TWO_POW_32}) + 6442450944, ${TWO_POW_32}) - ${TWO_POW_31} AS SIGNED)`;
}

/**
 * The low 32 bits of a bitwise result as a signed integer. The operators work on 64 unsigned bits,
 * so a negative operand arrives sign-extended and its high bits are masked off before the sign is
 * restored.
 */
function Wrapped(value: Sql): Sql {
  return sql`(CAST((((${value}) & ${LOW_32_BITS}) + ${TWO_POW_31}) MOD ${TWO_POW_32} AS SIGNED) - ${TWO_POW_31})`;
}

function ShiftCount(count: Sql): Sql {
  return sql`(${count} & ${SHIFT_MASK})`;
}

const int32: Int32Syntax = {
  read: ReadInt32,
  and: (left, right) => Wrapped(sql`${left} & ${right}`),
  or: (left, right) => Wrapped(sql`${left} | ${right}`),
  xor: (left, right) => Wrapped(sql`${left} ^ ${right}`),
  not: (value) => Wrapped(sql`~(${value})`),
  shiftLeft: (value, count) => Wrapped(sql`${value} << ${ShiftCount(count)}`),
  shiftRight: (value, count) => Wrapped(sql`${value} >> ${ShiftCount(count)}`),
  shiftRightUnsigned: (value, count) =>
    sql`((${value} & ${LOW_32_BITS}) >> ${ShiftCount(count)})`,
};

const ESCAPE = "\\";
const CLASS_OPEN = "[";
const CLASS_CLOSE = "]";

/**
 * What JavaScript's `.` matches, which is everything but its four line terminators. ICU's own `.`
 * also stops at a vertical tab and at U+0085, where JavaScript's does not.
 */
const JS_DOT = "[^\\n\\r\\u2028\\u2029]";

/** JavaScript's `$` is the end of the input alone; ICU's also matches before a final line terminator. */
const END_OF_INPUT = "\\z";

const OUTSIDE_CLASS = new Map([
  [".", JS_DOT],
  ["$", END_OF_INPUT],
]);

/**
 * The members of JavaScript's `\d`, `\w` and `\s`: ASCII digits, ASCII word characters, and its
 * own whitespace and line terminators. ICU reads its escapes as Unicode classes, which also hold
 * other scripts' digits and letters, and a different whitespace.
 */
const JS_DIGIT = "0-9";
const JS_WORD = "A-Za-z0-9_";
const JS_SPACE =
  "\\t\\n\\x{0B}\\f\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}";

const WORD = `[${JS_WORD}]`;

/** JavaScript's `\v` is the vertical tab alone, where ICU's is every vertical whitespace. */
const VERTICAL_TAB = "\\x{0B}";

/**
 * The escapes JavaScript reads otherwise than ICU outside a class, as the ICU that reads them the
 * JavaScript way. A word boundary is spelled with lookarounds over JavaScript's `\w`.
 */
const OUTSIDE_CLASS_ESCAPES = new Map([
  ["d", `[${JS_DIGIT}]`],
  ["D", `[^${JS_DIGIT}]`],
  ["w", WORD],
  ["W", `[^${JS_WORD}]`],
  ["s", `[${JS_SPACE}]`],
  ["S", `[^${JS_SPACE}]`],
  ["b", `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`],
  ["B", `(?:(?<=${WORD})(?=${WORD})|(?<!${WORD})(?!${WORD}))`],
  ["v", VERTICAL_TAB],
]);

/**
 * The same escapes inside a class, as members of it: a negated one as a nested set, which ICU
 * unites with the rest of the class. JavaScript's `[\b]` is a backspace.
 */
const INSIDE_CLASS_ESCAPES = new Map([
  ["d", JS_DIGIT],
  ["D", `[^${JS_DIGIT}]`],
  ["w", JS_WORD],
  ["W", `[^${JS_WORD}]`],
  ["s", JS_SPACE],
  ["S", `[^${JS_SPACE}]`],
  ["b", "\\x{08}"],
  ["v", VERTICAL_TAB],
]);

/**
 * The escapes that stand for a set of characters. JavaScript never reads one as an end of a range:
 * `\d-a` inside a class is three members, the hyphen and `a` included.
 */
const SET_ESCAPES = new Set(["d", "D", "w", "W", "s", "S"]);

/**
 * The characters ICU reads otherwise than JavaScript inside a class, each escaped where it stands
 * for itself: a nested set, an intersection, and the hyphen, which ICU reads doubled as a set
 * difference.
 */
const CLASS_SYNTAX = new Set(["[", "&", "-"]);

const HYPHEN = "-";
const NEGATION = "^";

/** The escapes of one character that run past the character after the backslash, by their length. */
const LONG_ESCAPES = [
  { letter: "x", pattern: /^[0-9A-Fa-f]{2}/u, length: 2 },
  { letter: "u", pattern: /^[0-9A-Fa-f]{4}/u, length: 4 },
  { letter: "c", pattern: /^[A-Za-z]/u, length: 1 },
];

/** How many characters the escape at `at` spans, the backslash included. */
function EscapeLength(pattern: string, at: number): number {
  const letter = pattern[at + 1];
  const rest = pattern.slice(at + 2);
  const long = LONG_ESCAPES.find(
    (escape) => escape.letter === letter && escape.pattern.test(rest),
  );
  return 2 + (long?.length ?? 0);
}

/**
 * One member of a class as JavaScript reads it, spelled for ICU. A set escape stands for many
 * characters, so it never ends a range; an unescaped hyphen is the one member that can join the two
 * beside it into one.
 */
interface ClassAtom {
  readonly icu: string;
  readonly isSet: boolean;
  readonly isRangeHyphen: boolean;
}

function ClassAtoms(body: string): ClassAtom[] {
  const atoms: ClassAtom[] = [];
  for (let at = 0; at < body.length; at++) {
    const char = body[at];
    if (char === ESCAPE && at + 1 < body.length) {
      const length = EscapeLength(body, at);
      const escaped = body[at + 1];
      atoms.push({
        icu: INSIDE_CLASS_ESCAPES.get(escaped) ?? body.slice(at, at + length),
        isSet: SET_ESCAPES.has(escaped),
        isRangeHyphen: false,
      });
      at += length - 1;
      continue;
    }
    atoms.push({
      icu: CLASS_SYNTAX.has(char) ? ESCAPE + char : char,
      isSet: false,
      isRangeHyphen: char === HYPHEN,
    });
  }
  return atoms;
}

/**
 * A class body as ICU reads it the JavaScript way. JavaScript reads the members left to right, and
 * a member, a hyphen and a member are one range, or three members where either end is a set escape.
 * Every other hyphen stands for itself, and so does every member after a range.
 */
function TranslateClass(body: string): string {
  const negated = body.startsWith(NEGATION);
  const atoms = ClassAtoms(negated ? body.slice(1) : body);
  let out = negated ? NEGATION : "";
  for (let at = 0; at < atoms.length; at++) {
    const low = atoms[at];
    const hyphen = atoms.at(at + 1);
    const high = atoms.at(at + 2);
    if (!hyphen?.isRangeHyphen || !high) {
      out += low.icu;
      continue;
    }
    out +=
      low.isSet || high.isSet
        ? low.icu + hyphen.icu + high.icu
        : low.icu + HYPHEN + high.icu;
    at += 2;
  }
  return out;
}

/** Where the class opened at `open` closes: its first unescaped `]`, or the end of the pattern. */
function ClassEnd(pattern: string, open: number): number {
  for (let at = open + 1; at < pattern.length; at++) {
    if (pattern[at] === ESCAPE) {
      at++;
    } else if (pattern[at] === CLASS_CLOSE) {
      return at;
    }
  }
  return pattern.length;
}

/**
 * Rewrites a JavaScript pattern into ICU's flavour, following escapes and classes. Only a literal
 * pattern reaches it: a pattern the statement computes is bound as it is.
 */
function TranslatePattern(pattern: string): string {
  let out = "";
  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at];
    if (char === ESCAPE && at + 1 < pattern.length) {
      const escaped = pattern[at + 1];
      out += OUTSIDE_CLASS_ESCAPES.get(escaped) ?? char + escaped;
      at++;
      continue;
    }
    if (char === CLASS_OPEN) {
      const end = ClassEnd(pattern, at);
      out += `${CLASS_OPEN}${TranslateClass(pattern.slice(at + 1, end))}${pattern.slice(end, end + 1)}`;
      at = end;
      continue;
    }
    out += OUTSIDE_CLASS.get(char) ?? char;
  }
  return out;
}

const regex: RegexSyntax = {
  translate: TranslatePattern,
  matches: (text, pattern) => sql`REGEXP_LIKE(${text}, ${pattern}, 'c')`,
};

export const scalar: ScalarSyntax = {
  cast: (value, kind) => CASTS[kind](value),
  bind,
  parseNumber: (text) =>
    sql`(CASE WHEN ${text} REGEXP ${NUMERIC_TEXT} THEN CAST(${text} AS DOUBLE) END)`,
  truncate: (value) => sql`TRUNCATE(${value}, 0)`,
  concat: (parts) => sql`CONCAT(${join(parts, sql`, `)})`,
  left: (text, width) => sql`LEFT(${text}, ${int(width)})`,
  int32,
  regex,
};
