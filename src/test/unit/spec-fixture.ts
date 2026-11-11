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
    if (saved) {
      SetOptions(saved);
    } else {
      ClearOptions();
    }
  }
}

/** A value a JSON configuration can hold. */
export type ForeignValue =
  | string
  | number
  | boolean
  | null
  | Record<string, never>
  | readonly string[];

/**
 * Options carrying a value their type refuses, as an untyped project configuration can deliver
 * one: the property is defined at runtime, past the compiler.
 */
export function Untyped(option: string, value: ForeignValue): Options {
  const options: Options = {};
  Object.defineProperty(options, option, { value, enumerable: true });
  return options;
}
