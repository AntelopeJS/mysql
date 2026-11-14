import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";

import { NormalizeInstanceId } from "../../implementations/database/utils";

function Created(id: string | undefined) {
  return NormalizeInstanceId(
    "createInstance",
    QueryStage("createInstance", { id }),
  );
}

describe("NormalizeInstanceId", () => {
  it("maps an absent id to the default instance", () => {
    expect(Created(undefined)).to.equal("");
  });

  it("passes a named id through", () => {
    expect(Created("alpha")).to.equal("alpha");
  });

  it("accepts 128 characters and refuses 129, the width of the instance column", () => {
    expect(Created("é".repeat(128))).to.equal("é".repeat(128));
    expect(() => Created("a".repeat(129))).to.throw(
      /longer than 128 characters/,
    );
  });
});
