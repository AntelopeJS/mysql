import { expect } from "chai";
import type { QueryStage } from "@antelopejs/interface-database/common";
import type { SchemaDefinition } from "@antelopejs/interface-database/schema";

import { type Sql, ident, sql } from "../statement";
import { Read } from "../connection";
import {
  CreateInstance,
  DestroyInstance,
  ListInstances,
} from "../implementations/database/instances";
import { Schemas } from "../implementations/database/schema";
import { PhysicalTable, Run } from "./tables";

const SCHEMA_ID = "instances_registry";
const OTHER_SCHEMA_ID = "instances_neighbour";

const DEFINITION: SchemaDefinition = {
  items: { fields: { name: "string" }, indexes: {} },
  notes: { fields: { text: "string" }, indexes: {} },
};

function Create(id?: string): QueryStage {
  return { stage: "createInstance", args: [], options: { id } };
}

function Destroy(id?: string): QueryStage {
  return { stage: "destroyInstance", args: [], options: { id } };
}

function Table(schemaId: string, tableId: string): Sql {
  return ident(PhysicalTable(schemaId, tableId));
}

/** One row per table for each of the default instance, `alpha` and `beta`. */
async function Seed(schemaId: string): Promise<void> {
  for (const tableId of ["items", "notes"]) {
    const table = Table(schemaId, tableId);
    await Run(sql`DELETE FROM ${table}`);
    await Run(
      sql`INSERT INTO ${table} (_id, _instance) VALUES ('row', ''), ('row', 'alpha'), ('row', 'beta')`,
    );
  }
}

async function InstancesWithRows(
  schemaId: string,
  tableId: string,
): Promise<string[]> {
  const rows = await Read(
    sql`SELECT _instance AS instance FROM ${Table(schemaId, tableId)} ORDER BY _instance`,
  );
  return rows.map((row) => String(row.get("instance")));
}

describe("the instance registry", function () {
  this.timeout(30_000);
  before(async () => {
    await Schemas.register(SCHEMA_ID, DEFINITION);
    await Schemas.register(OTHER_SCHEMA_ID, DEFINITION);
  });

  beforeEach(async () => {
    for (const schemaId of [SCHEMA_ID, OTHER_SCHEMA_ID]) {
      await Seed(schemaId);
      for (const id of await ListInstances(schemaId)) {
        await DestroyInstance(schemaId, [], Destroy(id));
      }
    }
  });

  after(() => {
    Schemas.unregister(SCHEMA_ID);
    Schemas.unregister(OTHER_SCHEMA_ID);
  });

  it("lists the named instances created, once each, and never the default one", async () => {
    expect(await CreateInstance(SCHEMA_ID, Create("beta"))).to.equal("beta");
    expect(await CreateInstance(SCHEMA_ID, Create("alpha"))).to.equal("alpha");
    expect(await CreateInstance(SCHEMA_ID, Create("alpha"))).to.equal("alpha");
    expect(await CreateInstance(SCHEMA_ID, Create())).to.equal("");
    expect(await ListInstances(SCHEMA_ID)).to.deep.equal(["alpha", "beta"]);
    expect(await ListInstances(OTHER_SCHEMA_ID)).to.deep.equal([]);
  });

  it("destroys an instance's rows in every table of its schema and forgets it, nothing else", async () => {
    await CreateInstance(SCHEMA_ID, Create("alpha"));
    await CreateInstance(SCHEMA_ID, Create("beta"));
    await CreateInstance(OTHER_SCHEMA_ID, Create("alpha"));
    await DestroyInstance(SCHEMA_ID, ["items", "notes"], Destroy("alpha"));
    expect(await ListInstances(SCHEMA_ID)).to.deep.equal(["beta"]);
    expect(await InstancesWithRows(SCHEMA_ID, "items")).to.deep.equal([
      "",
      "beta",
    ]);
    expect(await InstancesWithRows(SCHEMA_ID, "notes")).to.deep.equal([
      "",
      "beta",
    ]);
    expect(await ListInstances(OTHER_SCHEMA_ID)).to.deep.equal(["alpha"]);
    expect(await InstancesWithRows(OTHER_SCHEMA_ID, "items")).to.deep.equal([
      "",
      "alpha",
      "beta",
    ]);
  });

  it("changes nothing when destroying fails part way", async () => {
    await CreateInstance(SCHEMA_ID, Create("alpha"));
    const failed = await DestroyInstance(
      SCHEMA_ID,
      ["items", "missing"],
      Destroy("alpha"),
    ).then(
      () => false,
      () => true,
    );
    expect(failed, "a table that does not exist fails the destroy").to.equal(
      true,
    );
    expect(await ListInstances(SCHEMA_ID)).to.deep.equal(["alpha"]);
    expect(await InstancesWithRows(SCHEMA_ID, "items")).to.deep.equal([
      "",
      "alpha",
      "beta",
    ]);
  });
});
