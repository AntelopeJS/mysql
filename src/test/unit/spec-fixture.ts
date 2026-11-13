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
