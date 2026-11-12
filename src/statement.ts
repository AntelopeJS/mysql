/** What the driver binds. Booleans, JSON and dates are encoded by the dialect before they get here. */
export type SqlValue = string | number | bigint | null | Buffer;

/** A statement ready for the driver: positional `?` text and its arguments, in textual order. */
export interface Bound {
  readonly sql: string;
  readonly args: readonly SqlValue[];
}

/**
 * The longest identifier MySQL and MariaDB accept, in characters, for tables, columns, indexes and
 * triggers. Every generated name is fitted to it before it is quoted.
 */
export const MAX_IDENTIFIER_CHARS = 64;

const BACKTICK = "`";
const QUOTE = "'";
const BACKSLASH = "\\";
const NUL = "\0";
const PLACEHOLDER = "?";

class BoundValue {
  public constructor(public readonly value: SqlValue) {}
}

type Part = string | BoundValue;

/**
 * SQL text with its bound values held in place, in the order they appear.
 *
 * Only the constructors in this file make one: the `sql` tag over literal template text, `ident`,
 * `lit`, `int`, `param` and `join`. A string never type-checks where an `Sql` is expected, and lint
 * refuses an `Sql` interpolated into a plain template literal, so caller data reaches a statement
 * only as a bound value. A fragment may be repeated anywhere: each occurrence of a value becomes
 * its own `?` and its own argument when {@link Bind} flattens the statement.
 */
class Sql {
  readonly #parts: readonly Part[];

  public constructor(parts: readonly Part[]) {
    this.#parts = parts;
  }

  /** Joins text and fragments into one fragment, merging adjacent text. */
  public static Concat(pieces: readonly (string | Sql)[]): Sql {
    const parts: Part[] = [];
    for (const piece of pieces) {
      for (const part of piece instanceof Sql ? piece.#parts : [piece]) {
        const last = parts.at(-1);
        if (
          part instanceof BoundValue ||
          last === undefined ||
          last instanceof BoundValue
        ) {
          parts.push(part);
        } else {
          parts[parts.length - 1] = `${last}${part}`;
        }
      }
    }
    return new Sql(parts);
  }

  /** Flattens the fragment into positional text and its arguments. */
  public static Flatten(statement: Sql): Bound {
    let text = "";
    const args: SqlValue[] = [];
    for (const part of statement.#parts) {
      if (part instanceof BoundValue) {
        text += PLACEHOLDER;
        args.push(part.value);
      } else {
        text += part;
      }
    }
    return { sql: text, args };
  }
}

export type { Sql };

function RefuseNul(text: string, what: string): void {
  if (text.includes(NUL)) {
    throw new Error(`${what} cannot contain NUL characters`);
  }
}

/** Composes a fragment from literal template text and the fragments interpolated into it. */
export function sql(
  strings: TemplateStringsArray,
  ...fragments: readonly Sql[]
): Sql {
  const pieces: (string | Sql)[] = [strings[0]];
  fragments.forEach((fragment, index) => {
    pieces.push(fragment, strings[index + 1]);
  });
  return Sql.Concat(pieces);
}

/**
 * Quotes one identifier with backticks, doubling any backtick inside it.
 *
 * Refuses a NUL, which MySQL never accepts in a name, and a name longer than
 * {@link MAX_IDENTIFIER_CHARS}, which the server would refuse only once the statement runs.
 */
export function ident(name: string): Sql {
  RefuseNul(name, "Identifiers");
  const length = Array.from(name).length;
  if (length > MAX_IDENTIFIER_CHARS) {
    throw new Error(
      `Identifier '${name}' is ${length} characters long; MySQL accepts at most ${MAX_IDENTIFIER_CHARS}`,
    );
  }
  return Sql.Concat([
    `${BACKTICK}${name.replaceAll(BACKTICK, BACKTICK + BACKTICK)}${BACKTICK}`,
  ]);
}

/**
 * A string literal for text the module itself writes: JSON paths, index signatures, comments,
 * session settings. Caller data is bound with {@link param}, never quoted.
 *
 * Backslashes are escaped because every session runs without `NO_BACKSLASH_ESCAPES`, which the
 * dialect's session pin guarantees.
 */
export function lit(text: string): Sql {
  RefuseNul(text, "String literals");
  const escaped = text
    .replaceAll(BACKSLASH, BACKSLASH + BACKSLASH)
    .replaceAll(QUOTE, QUOTE + QUOTE);
  return Sql.Concat([`${QUOTE}${escaped}${QUOTE}`]);
}

/** An integer literal, for widths and limits the module computes; refuses anything but a safe integer. */
export function int(value: number): Sql {
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `Expected a safe integer for an SQL literal, received ${String(value)}`,
    );
  }
  return Sql.Concat([String(value)]);
}

/** A bound value: it reaches the server as an argument, never as statement text. */
export function param(value: SqlValue): Sql {
  return new Sql([new BoundValue(value)]);
}

/** Joins fragments with a separator, as `Array.prototype.join` does for text. */
export function join(fragments: readonly Sql[], separator: Sql): Sql {
  return Sql.Concat(
    fragments.flatMap((fragment, index) =>
      index === 0 ? [fragment] : [separator, fragment],
    ),
  );
}

/**
 * Turns a statement into positional `?` text and its arguments, in the order the values occur.
 *
 * A value repeated in the text is an argument per occurrence, so a fragment can be reused in one
 * statement without disturbing the order of the others.
 */
export function Bind(statement: Sql): Bound {
  return Sql.Flatten(statement);
}
