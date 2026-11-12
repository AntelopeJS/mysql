import { expect } from "chai";
import type {
  SchemaDefinition,
  TableDefinition,
} from "@antelopejs/interface-database/schema";

import { DIALECTS } from "../../dialect";
import { ParseSchema, ParseTable } from "../../implementations/database/fields";
import {
  BuildSchemaPlan,
  BuildTablePlan,
  IndexFields,
  type IndexPlan,
  type PlanContext,
  type PlannedTable,
  ServesCrossInstance,
} from "../../implementations/database/plan";
import type { KeyPart } from "../../implementations/database/paths";

const CONTEXT: PlanContext = { prefix: "", session: DIALECTS.mysql.session };

function Plan(
  definition: TableDefinition,
  context: PlanContext = CONTEXT,
): PlannedTable {
  return BuildTablePlan(
    "shop",
    "items",
    definition,
    ParseTable(definition, "shop.items"),
    context,
  );
}

function Index(definition: TableDefinition, name: string): IndexPlan {
  const found = Plan(definition).plan.indexes.find(
    (index) => index.name === name,
  );
  expect(found, `index ${name}`).to.not.equal(undefined);
  return found ?? Plan(definition).plan.indexes[0];
}

/** Each part as `kind:column`, with the read and the fit of a key column, and the fit of a value key's text. */
function Parts(index: IndexPlan): string[] {
  return index.parts.map((part: KeyPart) => {
    switch (part.kind) {
      case "instance":
      case "stored":
        return `${part.kind}:${part.column}`;
      case "elements":
        return `elements:${part.column}:${part.elem.kind}`;
      case "key": {
        const { key } = part;
        const fit = "fit" in key ? `:${key.fit.kind}${key.fit.width}` : "";
        return `key:${key.source}${JSON.stringify(key.path)}:${key.read}${fit}`;
      }
      case "value": {
        const { text } = part.key;
        return `value:${text.source}${JSON.stringify(text.path)}:${text.fit.kind}${text.fit.width}`;
      }
    }
  });
}

describe("BuildTablePlan columns", () => {
  it("stores the key, the instance, the declared fields and the overflow, in that order", () => {
    const { plan } = Plan({
      fields: { name: "string", price: "number" },
      indexes: {},
    });
    expect(plan.table).to.equal("shop__items");
    expect(plan.columns).to.deep.equal([
      { role: "id", name: "_id", chars: 512 },
      { role: "instance", name: "_instance", chars: 128 },
      { role: "declared", name: "name", field: "name", type: { kind: "text" } },
      {
        role: "declared",
        name: "price",
        field: "price",
        type: { kind: "float" },
      },
      { role: "extra", name: "_extra" },
    ]);
    expect(plan.keyColumns).to.deep.equal([]);
  });

  it("puts the configured prefix before the schema id", () => {
    const { plan } = Plan(
      { fields: {}, indexes: {} },
      { ...CONTEXT, prefix: "app_" },
    );
    expect(plan.table).to.equal("app_shop__items");
  });
});

describe("BuildTablePlan key parts", () => {
  it("keys a declared number on its own column, after the instance", () => {
    const index = Index(
      { fields: { price: "number" }, indexes: { price: {} } },
      "price",
    );
    expect(Parts(index)).to.deep.equal(["instance:_instance", "stored:price"]);
    expect(index.signature).to.equal("antelopejs:1:btree:_instance,price");
  });

  it("keys a declared string through a prefix key column, the whole budget its own", () => {
    const index = Index(
      { fields: { slug: "string" }, indexes: { slug: {} } },
      "slug",
    );
    expect(Parts(index)).to.deep.equal([
      "instance:_instance",
      "key:slug[]:text:prefix640",
    ]);
  });

  it("keys a unique string on the exact value, so the index decides equality", () => {
    const index = Index(
      { fields: { slug: "string" }, indexes: { slug: { unique: true } } },
      "slug",
    );
    expect(index.unique).to.equal(true);
    expect(Parts(index)).to.deep.equal([
      "instance:_instance",
      "key:slug[]:text:exact640",
    ]);
    expect(index.signature).to.match(
      /^antelopejs:1:btree:unique:_instance,__k_slug_/,
    );
  });

  it("reads a dotted field below a declared document as a nested path, keyed as a value of any kind", () => {
    const index = Index(
      {
        fields: { title: "object" },
        indexes: { titleFr: { fields: ["title.fr"] } },
      },
      "titleFr",
    );
    expect(Parts(index)).to.deep.equal([
      "instance:_instance",
      'value:title["fr"]:prefix638',
    ]);
  });

  it("keys a path a nested record declares a string by its text alone", () => {
    const index = Index(
      {
        fields: { title: { fr: "string", en: "string" } },
        indexes: { titleFr: { fields: ["title.fr"] } },
      },
      "titleFr",
    );
    expect(Parts(index)).to.deep.equal([
      "instance:_instance",
      'key:title["fr"]:string:prefix640',
    ]);
  });

  it("reads a path below `_extra` when its first segment is undeclared", () => {
    const owner = Index(
      {
        fields: { title: "object" },
        indexes: { owner: { fields: ["_internal.data.owner"] } },
      },
      "owner",
    );
    expect(Parts(owner)).to.deep.equal([
      "instance:_instance",
      'value:_extra["_internal","data","owner"]:prefix638',
    ]);
    const sku = Index({ fields: {}, indexes: { sku: {} } }, "sku");
    expect(Parts(sku)).to.deep.equal([
      "instance:_instance",
      'value:_extra["sku"]:prefix638',
    ]);
  });

  it("reads a member by its declared type: a number as a number, a string as text", () => {
    const index = Index(
      {
        fields: { stats: { rank: "number", label: "string" } },
        indexes: { ranked: { fields: ["stats.rank", "stats.label"] } },
      },
      "ranked",
    );
    expect(Parts(index)).to.deep.equal([
      "instance:_instance",
      'key:stats["rank"]:double',
      'key:stats["label"]:string:prefix638',
    ]);
  });

  it("keys a whole document as a value of any kind, its number taking 8 bytes of the budget", () => {
    const index = Index(
      { fields: { title: "object" }, indexes: { title: {} } },
      "title",
    );
    expect(Parts(index)).to.deep.equal([
      "instance:_instance",
      "value:title[]:prefix638",
    ]);
  });

  it("prefers a declared field named with a dot over a path", () => {
    const index = Index(
      { fields: { "a.b": "number" }, indexes: { ab: { fields: ["a.b"] } } },
      "ab",
    );
    expect(Parts(index)).to.deep.equal(["instance:_instance", "stored:a.b"]);
  });
});

describe("BuildTablePlan key widths", () => {
  it("splits the budget between text parts, narrowing them rather than refusing a third", () => {
    const two = Index(
      {
        fields: { a: "string", b: "string" },
        indexes: { ab: { fields: ["a", "b"] } },
      },
      "ab",
    );
    expect(Parts(two)).to.deep.equal([
      "instance:_instance",
      "key:a[]:text:prefix320",
      "key:b[]:text:prefix320",
    ]);
    const three = Index(
      {
        fields: { a: "string", b: "string", c: "string" },
        indexes: { abc: { fields: ["a", "b", "c"] } },
      },
      "abc",
    );
    expect(Parts(three).slice(1)).to.deep.equal([
      "key:a[]:text:prefix213",
      "key:b[]:text:prefix213",
      "key:c[]:text:prefix213",
    ]);
  });

  it("takes fixed-width parts out of the budget before the text parts", () => {
    const index = Index(
      {
        fields: { name: "string" },
        indexes: { byKey: { fields: ["_id", "name"] } },
      },
      "byKey",
    );
    expect(Parts(index)).to.deep.equal([
      "instance:_instance",
      "stored:_id",
      "key:name[]:text:prefix128",
    ]);
  });

  it("refuses an index whose fixed-width parts alone overrun the key, with the arithmetic", () => {
    expect(() =>
      Plan({ fields: {}, indexes: { twice: { fields: ["_id", "_id"] } } }),
    ).to.throw(/needs 512 bytes for the instance and 4096 .* 3072-byte key/);
  });

  it("gives a unique and a non-unique index over one field a key column each", () => {
    const { plan } = Plan({
      fields: { slug: "string" },
      indexes: { slug: { unique: true }, bySlug: { fields: ["slug"] } },
    });
    expect(
      plan.keyColumns.map((key) => ("fit" in key ? key.fit.kind : "")),
    ).to.deep.equal(["exact", "prefix"]);
  });
});

describe("BuildTablePlan multi and crossInstance indexes", () => {
  it("shares one key column between the scoped index and its crossInstance twin", () => {
    const { plan } = Plan({
      fields: { slug: "string" },
      indexes: { slug: { unique: true, crossInstance: true } },
    });
    expect(plan.indexes.map((index) => index.name)).to.deep.equal([
      "slug",
      "slug__g",
    ]);
    const [scoped, twin] = plan.indexes;
    expect(twin.unique).to.equal(false);
    expect(Parts(twin)).to.deep.equal(Parts(scoped).slice(1));
    expect(plan.keyColumns).to.have.length(1);
  });

  it("indexes the elements of a declared array with a multi-valued index", () => {
    const index = Index(
      { fields: { tags: "string[]" }, indexes: { tags: { multi: true } } },
      "tags",
    );
    expect(Parts(index)).to.deep.equal([
      "instance:_instance",
      "elements:tags:text",
    ]);
    expect(index.signature).to.equal("antelopejs:1:mv:_instance,tags[text]");
  });

  it("keys a multi index over anything but one array field as a btree", () => {
    const index = Index(
      { fields: { price: "number" }, indexes: { price: { multi: true } } },
      "price",
    );
    expect(Parts(index)).to.deep.equal(["instance:_instance", "stored:price"]);
  });

  it("keys a multi index over an array of anything but strings by the whole array", () => {
    const index = Index(
      { fields: { scores: "number[]" }, indexes: { scores: { multi: true } } },
      "scores",
    );
    expect(Parts(index)).to.deep.equal([
      "instance:_instance",
      "value:scores[]:prefix638",
    ]);
  });

  it("refuses a unique multi index over an array field", () => {
    expect(() =>
      Plan({
        fields: { tags: "string[]" },
        indexes: { tags: { multi: true, unique: true } },
      }),
    ).to.throw(/unique and multi over an array field/);
  });

  it("reports a multi index the engine cannot build and builds the rest", () => {
    const { plan, refusals } = Plan(
      {
        fields: { tags: "string[]", price: "number" },
        indexes: { tags: { multi: true }, price: {} },
      },
      {
        ...CONTEXT,
        session: { ...CONTEXT.session, multiValuedIndex: false },
      },
    );
    expect(plan.indexes.map((index) => index.id)).to.deep.equal(["price"]);
    expect(refusals).to.have.length(1);
    expect(refusals[0]).to.include({ table: "items", index: "tags" });
  });

  it("changes the signature whenever the index would be built differently", () => {
    const plain = Index(
      { fields: { slug: "string" }, indexes: { slug: {} } },
      "slug",
    );
    const unique = Index(
      { fields: { slug: "string" }, indexes: { slug: { unique: true } } },
      "slug",
    );
    const twoFields = Index(
      {
        fields: { slug: "string", b: "string" },
        indexes: { slug: { fields: ["slug", "b"] } },
      },
      "slug",
    );
    expect(
      new Set([plain.signature, unique.signature, twoFields.signature]).size,
    ).to.equal(3);
  });
});

describe("BuildTablePlan refusals", () => {
  for (const field of ["_instance", "_extra", "_extra.x", "_Instance"]) {
    it(`refuses an index on the reserved '${field}'`, () => {
      expect(() =>
        Plan({ fields: {}, indexes: { bad: { fields: [field] } } }),
      ).to.throw(/reserved column/);
    });
  }

  it("refuses a path below a declared scalar, naming it", () => {
    expect(() =>
      Plan({
        fields: { title: "string" },
        indexes: { bad: { fields: ["title.fr"] } },
      }),
    ).to.throw(/'title' is declared as a value with no members/);
    expect(() =>
      Plan({
        fields: { title: { fr: "string" } },
        indexes: { bad: { fields: ["title.fr.short"] } },
      }),
    ).to.throw(/'title.fr' is declared as a value with no members/);
  });

  it("refuses two index ids MySQL reads as one name", () => {
    expect(() =>
      Plan({
        fields: { slug: "string" },
        indexes: { slug: {}, Slug: { fields: ["slug"] } },
      }),
    ).to.throw(/claimed by both index 'slug' .* and index 'Slug'/);
    expect(() =>
      Plan({
        fields: { a: "string" },
        indexes: {
          a: { crossInstance: true },
          a__g: { fields: ["a"] },
        },
      }),
    ).to.throw(/'a__g' is claimed by both/);
  });
});

describe("BuildSchemaPlan", () => {
  it("refuses two tables MySQL may read as one name", () => {
    const schema: SchemaDefinition = {
      items: { fields: {}, indexes: {} },
      Items: { fields: {}, indexes: {} },
    };
    expect(() =>
      BuildSchemaPlan("shop", schema, ParseSchema("shop", schema), CONTEXT),
    ).to.throw(/claimed by both table 'items' and table 'Items'/);
  });

  it("plans every table and gathers their refusals", () => {
    const schema: SchemaDefinition = {
      items: {
        fields: { tags: "string[]" },
        indexes: { tags: { multi: true } },
      },
      orders: { fields: {}, indexes: {} },
    };
    const planned = BuildSchemaPlan(
      "shop",
      schema,
      ParseSchema("shop", schema),
      { ...CONTEXT, session: { ...CONTEXT.session, multiValuedIndex: false } },
    );
    expect(planned.tables.map((plan) => plan.table)).to.deep.equal([
      "shop__items",
      "shop__orders",
    ]);
    expect(planned.refusals.map((refusal) => refusal.index)).to.deep.equal([
      "tags",
    ]);
  });
});

describe("IndexFields and ServesCrossInstance", () => {
  it("expands an index without fields to its own name", () => {
    expect(IndexFields("price", {})).to.deep.equal(["price"]);
    expect(IndexFields("byCar", { fields: ["car", "price"] })).to.deep.equal([
      "car",
      "price",
    ]);
  });

  it("serves a cross-instance read only from a crossInstance declaration", () => {
    expect(ServesCrossInstance({ crossInstance: true })).to.equal(true);
    expect(ServesCrossInstance({ multi: true })).to.equal(false);
    expect(ServesCrossInstance({})).to.equal(false);
  });
});
