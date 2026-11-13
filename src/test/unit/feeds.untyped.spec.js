import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";

import { Refused } from "./feeds-fixture";

describe("a change feed's refusals from an untyped caller", () => {
  it("keeps the fold's own wording for a stage nothing knows, which is a typo", async () => {
    const message = await Refused([QueryStage("filtr", {})]);
    expect(message).to.contain("Unsupported query stage 'filtr'");
    expect(message).to.not.contain("'changes'");
  });
});
