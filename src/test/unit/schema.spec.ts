import { expect } from "chai";
import type { SchemaDefinition } from "@antelopejs/interface-database/schema";

import {
  GetIndex,
  GetSchema,
  GetTableModel,
  GetTableNames,
  Schemas,
  WaitForSchemaReady,
} from "../../implementations/database/schema";

const INHERITED = "constructor";

const BAD_SCHEMA: SchemaDefinition = {
  orders: { fields: { ref: "uuid" }, indexes: {} },
};

const ACCOUNTS: SchemaDefinition = {
  accounts: {
    fields: { name: "string" },
    indexes: { byName: { fields: ["name"] } },
  },
};

async function Rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    if (!(err instanceof Error)) {
      throw err;
    }
    return err;
  }
  throw new Error("expected the promise to reject");
}

describe("Schemas.register", () => {
  afterEach(() => {
    Schemas.unregister("broken");
  });

  it("keeps the parse failure in the readiness gate", async () => {
    const registered = await Rejection(Schemas.register("broken", BAD_SCHEMA));
    expect(registered.message).to.match(/uuid/);

    const gated = await Rejection(WaitForSchemaReady("broken"));
    expect(gated).to.equal(registered);
  });

  it("rolls back the definition and the parsed shape", async () => {
    await Rejection(Schemas.register("broken", BAD_SCHEMA));

    expect(() => GetSchema("broken")).to.throw(/Unknown schema/);
    expect(() => GetTableModel("broken", "orders")).to.throw(/Unknown schema/);
  });
});

describe("the registry accessors", () => {
  it("declines a schema named after an inherited member", () => {
    expect(() => GetSchema(INHERITED)).to.throw(
      `Unknown schema '${INHERITED}'`,
    );
    expect(() => GetTableModel(INHERITED, "orders")).to.throw(
      `Unknown schema '${INHERITED}'`,
    );
    expect(() => GetTableNames(INHERITED)).to.throw(
      `Unknown schema '${INHERITED}'`,
    );
  });

  it("gates a schema named after an inherited member on a real promise", () => {
    expect(WaitForSchemaReady(INHERITED)).to.be.an.instanceOf(Promise);
  });

  it("resolves a declared index, and an undeclared name as a bare field", async () => {
    const registered = Schemas.register("lookup", ACCOUNTS);
    try {
      expect(GetIndex("lookup", "accounts", "byName")).to.deep.equal({
        fields: ["name"],
      });
      expect(GetIndex("lookup", "accounts", "name")).to.deep.equal({
        fields: ["name"],
      });
      expect(() => GetIndex("lookup", "accounts", "name", true)).to.throw(
        /Unknown index 'name' on 'lookup.accounts'/,
      );
      expect(() => GetIndex("lookup", "accounts", "toString", true)).to.throw(
        /Unknown index 'toString'/,
      );
    } finally {
      await registered.catch(() => undefined);
      Schemas.unregister("lookup");
    }
  });
});

describe("a schema registered under an id named after an Object.prototype member", () => {
  for (const schemaId of ["__proto__", "constructor"]) {
    it(`finds ${schemaId} again like any other id`, async () => {
      const registered = Schemas.register(schemaId, ACCOUNTS);
      try {
        expect(GetSchema(schemaId)).to.equal(ACCOUNTS);
        expect(GetTableNames(schemaId)).to.deep.equal(["accounts"]);
      } finally {
        await registered.catch(() => undefined);
        Schemas.unregister(schemaId);
      }
    });
  }
});
