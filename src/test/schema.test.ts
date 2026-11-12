import { expect } from "chai";
import type { SchemaDefinition } from "@antelopejs/interface-database/schema";

import {
  GetCrossInstanceScanNotice,
  GetTablePlan,
  Schemas,
} from "../implementations/database/schema";

const SCHEMA_ID = "wave1_registration";

const BLOG: SchemaDefinition = {
  articles: {
    fields: { slug: "string", title: "object", views: "number" },
    indexes: {
      slug: { unique: true, crossInstance: true },
      titleFr: { fields: ["title.fr"] },
      owner: { fields: ["_internal.data.owner"] },
    },
  },
};

describe("a schema registered on a connected instance", () => {
  after(() => {
    Schemas.unregister(SCHEMA_ID);
  });

  it("plans its tables with the server's dialect and the configured prefix", async () => {
    await Schemas.register(SCHEMA_ID, BLOG);
    const plan = GetTablePlan(SCHEMA_ID, "articles");
    expect(plan.table).to.equal(`${SCHEMA_ID}__articles`);
    expect(plan.indexes.map((index) => index.name)).to.deep.equal([
      "slug",
      "slug__g",
      "titleFr",
      "owner",
    ]);
    expect(
      plan.keyColumns.map((key) => `${key.source}:${key.read}`),
    ).to.deep.equal([
      "slug:text",
      "title:ranked-text",
      "title:ranked-number",
      "_extra:ranked-text",
      "_extra:ranked-number",
    ]);
  });

  it("answers a cross-instance scan notice for each of its tables", () => {
    expect(GetCrossInstanceScanNotice(SCHEMA_ID, "articles")).to.be.a(
      "function",
    );
    expect(() => GetCrossInstanceScanNotice(SCHEMA_ID, "missing")).to.throw(
      `Unknown table '${SCHEMA_ID}.missing'`,
    );
  });
});
