/**
 * Runs `reproduce`, which states what the module should answer. It passes while `reproduce`
 * fails, and fails once `reproduce` passes, so the fix that makes the module answer right also
 * says to delete the expectation and the exclusion in `draw.ts` that goes round it.
 */
export async function ExpectedFailure(
  reproduce: () => Promise<void>,
): Promise<void> {
  try {
    await reproduce();
  } catch {
    return;
  }
  throw new Error(
    "the reproduction passes now: delete this expected failure, and let the draw pick the stage again",
  );
}
