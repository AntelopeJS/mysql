import { expect } from "chai";

import { ParseTable } from "../../implementations/database/fields";

describe("ParseTable from an untyped caller", () => {
  it("rejects a declaration that is neither a string, array nor object", () => {
    for (const declared of [null, 123, true]) {
      expect(() =>
        ParseTable({ fields: { f: declared }, indexes: {} }, "shop.orders"),
      ).to.throw(/Unsupported field type/);
    }
  });
});
