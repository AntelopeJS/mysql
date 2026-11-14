import { expect } from "chai";

import { Root, Written } from "./pipeline-fixture";

describe("An insert from an untyped caller", () => {
  it("refuses a conflict mode it does not know, naming the ones it does", () => {
    expect(() =>
      Written(Root().insert({ _id: "a" }, { conflict: "merge" })),
    ).to.throw(/conflict mode of update or replace/);
  });
});
