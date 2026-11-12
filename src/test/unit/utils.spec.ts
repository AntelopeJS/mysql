import { expect } from "chai";
import { QueryStage } from "@antelopejs/interface-database/common";
import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";

import { type ForeignValue, WithForeign } from "./spec-fixture";
import { NormalizeInstanceId } from "../../implementations/database/utils";

function Created(id: string | undefined) {
  return NormalizeInstanceId(
    "createInstance",
    QueryStage("createInstance", { id }),
  );
}

function CreatedFromUntyped(id: ForeignValue) {
  return NormalizeInstanceId(
    "createInstance",
    QueryStage("createInstance", WithForeign({ id: "" }, "id", id)),
  );
}

describe("NormalizeInstanceId", () => {
  it("maps an absent or null id to the default instance", () => {
    expect(Created(undefined)).to.equal("");
    expect(CreatedFromUntyped(null)).to.equal("");
  });

  it("passes a named id through", () => {
    expect(Created("alpha")).to.equal("alpha");
  });

  it("rejects CROSS_INSTANCE, naming the operation", () => {
    const stage = QueryStage(
      "destroyInstance",
      WithForeign({ id: "" }, "id", CROSS_INSTANCE),
    );
    expect(() => NormalizeInstanceId("destroyInstance", stage)).to.throw(
      /destroyInstance does not accept CROSS_INSTANCE/,
    );
  });

  it("rejects a non-string id, naming what it received", () => {
    expect(() => CreatedFromUntyped(7)).to.throw(/received number/);
    expect(() => CreatedFromUntyped(["a"])).to.throw(/received list/);
    expect(() => CreatedFromUntyped({})).to.throw(/received document/);
  });

  it("accepts 128 characters and refuses 129, the width of the instance column", () => {
    expect(Created("é".repeat(128))).to.equal("é".repeat(128));
    expect(() => Created("a".repeat(129))).to.throw(
      /longer than 128 characters/,
    );
  });
});
