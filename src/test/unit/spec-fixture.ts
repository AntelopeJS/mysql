import {
  ClearOptions,
  GetOptions,
  type Options,
  SetOptions,
} from "../../config";

function CurrentOptions(): Options | undefined {
  try {
    return GetOptions();
  } catch {
    return undefined;
  }
}

/**
 * Runs a synchronous body through a temporary configuration, restoring whatever was there.
 *
 * Generated names read the process-wide table prefix, and these specs share their process with a
 * live, constructed adapter: `ajs module test` runs them beside the conformance suites. Both the
 * set and the restore therefore happen inside one synchronous call, so no registration in flight
 * can observe either.
 */
export function WithOptions<T>(options: Options, read: () => T): T {
  const saved = CurrentOptions();
  SetOptions(options);
  try {
    return read();
  } finally {
    Restore(saved);
  }
}

function Restore(saved: Options | undefined) {
  if (saved) {
    SetOptions(saved);
  } else {
    ClearOptions();
  }
}

/** Runs a synchronous body with no configuration set, restoring whatever was there, as {@link WithOptions} does. */
export function WithoutOptions<T>(read: () => T): T {
  const saved = CurrentOptions();
  ClearOptions();
  try {
    return read();
  } finally {
    Restore(saved);
  }
}

/** A value an untyped caller can hand over: what a JSON configuration holds, or a symbol. */
export type ForeignValue =
  | string
  | number
  | boolean
  | null
  | symbol
  | Record<string, never>
  | readonly string[];

/**
 * `base` with `key` holding a value its type refuses, as an untyped caller can deliver one: the
 * property is defined at runtime, past the compiler.
 */
export function WithForeign<T>(base: T, key: string, value: ForeignValue): T {
  Object.defineProperty(base, key, { value, enumerable: true });
  return base;
}

/** Options carrying a value their type refuses, as an untyped project configuration can deliver one. */
export function Untyped(option: string, value: ForeignValue): Options {
  return WithForeign<Options>({}, option, value);
}
