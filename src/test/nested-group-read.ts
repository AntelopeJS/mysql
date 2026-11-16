import { expect } from "chai";

const CODE = "ANTELOPEJS_MYSQL_NESTED_GROUP_READ";

export function ByNumber(left: number, right: number): number {
  return left - right;
}

/** Runs a query the module refuses as it builds it, and checks the refusal's code. */
export async function ExpectRefused(run: () => Promise<object>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    expect(error).to.have.property("code", CODE);
    return;
  }
  expect.fail("the query was run, not refused");
}
