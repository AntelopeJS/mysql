import type { Parameters } from "fast-check";

const DEFAULT_SEED = 20_261_116;

function Positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return value;
}

/**
 * The bounds of a property: the cases drawn, `variable` or else `fallback`, from `CHAINS_SEED`, so
 * a run repeats until either changes. A property whose case takes seconds stops at the first
 * failure instead of shrinking it.
 */
export function Bounds(
  variable: string,
  fallback: number,
  shrinks = true,
): Parameters<unknown> {
  return {
    numRuns: Positive(variable, fallback),
    seed: Positive("CHAINS_SEED", DEFAULT_SEED),
    endOnFailure: !shrinks,
  };
}
