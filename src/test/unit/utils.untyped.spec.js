import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";
import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";

import { NormalizeInstanceId } from "../../implementations/database/utils";

describe("NormalizeInstanceId from an untyped caller", () => {
  it("maps a null id to the default instance", () => {
    const stage = QueryStage("createInstance", { id: null });
    expect(NormalizeInstanceId("createInstance", stage)).to.equal("");
  });

  it("rejects CROSS_INSTANCE, naming the operation", () => {
    const stage = QueryStage("destroyInstance", { id: CROSS_INSTANCE });
    expect(() => NormalizeInstanceId("destroyInstance", stage)).to.throw(
      /destroyInstance does not accept CROSS_INSTANCE/,
    );
  });

  it("rejects a non-string id, naming what it received", () => {
    for (const [id, received] of [
      [7, /received number/],
      [["a"], /received list/],
      [{}, /received document/],
    ]) {
      const stage = QueryStage("createInstance", { id });
      expect(() => NormalizeInstanceId("createInstance", stage)).to.throw(
        received,
      );
    }
  });
});
