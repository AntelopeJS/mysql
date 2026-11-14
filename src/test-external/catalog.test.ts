import { expect } from "chai";
import {
  CheckReference,
  DescribeRelations,
  Info,
  ListRelations,
  Profile,
  type RelationDescription,
  SampleRows,
  type RelationProfile,
  type RelationSummary,
} from "@antelopejs/interface-database-catalog";
import {
  Schema,
  type SchemaDefinition,
  type TableDefinition,
} from "@antelopejs/interface-database/schema";

import { GetOptions } from "../config";
import { sql } from "../statement";
import {
  SetMeasureTimeoutForTests,
  WithMeasures,
} from "../implementations/database/external-measures";
import {
  GetSchema,
  WaitForSchemaReady,
} from "../implementations/database/schema";
import { BIG_EVENTS_ROWS, CLIENT_USER } from "./fixture";
import { Native, NativeCount } from "./sales";

const SALES = "sales";
const SAMPLE_THRESHOLD = 1_000_000;
/** How far the server's sampled statistics may stray from the rows a table holds. */
const ESTIMATE_TOLERANCE = 0.5;

function Named(relations: RelationSummary[], name: string): RelationSummary {
  const found = relations.find((relation) => relation.name === name);
  if (!found) throw new Error(`no relation ${name} was listed`);
  return found;
}

/** The schema a generator writes from the catalog: every column as the declaration proposed first. */
function Generated(relations: RelationDescription[]): SchemaDefinition {
  const definition: SchemaDefinition = {};
  for (const relation of relations) {
    const fields: TableDefinition["fields"] = relation.key
      ? { _id: "string" }
      : {};
    for (const column of relation.columns) {
      if (column.accepts.length > 0) {
        fields[column.name] = column.accepts[0].declared;
      }
    }
    definition[relation.name] = { fields, indexes: {} };
  }
  return definition;
}

async function Mappable(): Promise<RelationDescription[]> {
  const listed = await ListRelations([SALES]);
  const names = listed
    .filter((relation) => !relation.unmappable)
    .map((relation) => `${SALES}.${relation.name}`);
  return DescribeRelations(names);
}

describe("the catalog of an external instance", function () {
  this.timeout(120_000);

  it("names the connection's engine, database and account", async () => {
    const info = await Info();
    expect(info).to.include({
      engine: /mariadb/i.test(info.version) ? "mariadb" : "mysql",
      database: SALES,
      role: CLIENT_USER,
    });
  });

  it("lists each relation with the key registration aliases _id to", async () => {
    const listed = await ListRelations([SALES]);
    expect(Named(listed, "accounts").key).to.deep.equal({
      columns: ["id"],
      source: "primary",
    });
    expect(Named(listed, "order_lines").key).to.deep.equal({
      columns: ["order_id", "line_no"],
      source: "primary",
    });
    expect(Named(listed, "events").key).to.deep.equal({
      columns: ["event_ref"],
      source: "unique",
    });
    expect(Named(listed, "tags").key).to.deep.equal({
      columns: ["id"],
      source: "primary",
    });
    for (const keyless of ["raw_log", "big_accounts", "daily_signups"]) {
      expect(Named(listed, keyless).key, keyless).to.equal(null);
    }
  });

  it("lists a partitioned table as partitioned, and a view as a view", async () => {
    const listed = await ListRelations([SALES]);
    expect(Named(listed, "tags").kind).to.equal("partitioned");
    expect(Named(listed, "accounts").kind).to.equal("table");
    expect(Named(listed, "big_accounts").kind).to.equal("view");
  });

  it("estimates a table's rows from the server's statistics, and a view's by plan", async () => {
    const listed = await ListRelations([SALES]);
    const accounts = Named(listed, "accounts");
    expect(accounts.estimate).to.equal("statistics");
    expect(accounts.estimatedRows).to.be.closeTo(
      20000,
      20000 * ESTIMATE_TOLERANCE,
    );
    const view = Named(listed, "big_accounts");
    expect(view.estimate).to.equal("plan");
    expect(view.estimatedRows).to.be.above(0);
  });

  it("lists a relation with column-only grants as unmappable, saying why", async () => {
    expect(Named(await ListRelations([SALES]), "people").unmappable).to.match(
      /some of its columns/,
    );
  });

  it("describes foreign keys both ways, enum labels and comments", async () => {
    const [accounts, contacts] = await DescribeRelations([
      "sales.accounts",
      "sales.contacts",
    ]);
    const reference = {
      name: "contacts_account_id_fkey",
      from: { relation: "sales.contacts", columns: ["account_id"] },
      to: { relation: "sales.accounts", columns: ["id"] },
    };
    expect(contacts.references).to.deep.include(reference);
    expect(accounts.referencedBy).to.deep.include(reference);
    const status = accounts.columns.find((column) => column.name === "status");
    expect(status?.enumLabels).to.deep.equal(["lead", "active", "churned"]);
    expect(accounts.comment).to.equal("Customer accounts");
    expect(
      accounts.columns.find((column) => column.name === "name")?.comment,
    ).to.equal("Display name");
  });

  it("marks generated and SET columns read-only, and an AUTO_INCREMENT key an identity by default", async () => {
    const [accounts] = await DescribeRelations(["sales.w_accounts"]);
    const readOnly = accounts.columns
      .filter((column) => column.readOnly)
      .map((column) => column.name);
    expect(readOnly).to.have.members(["upper_code", "perms"]);
    expect(
      accounts.columns.find((column) => column.name === "id")?.identity,
    ).to.equal("by default");
  });

  it("refuses to describe a relation the account cannot see, naming it", async () => {
    try {
      await DescribeRelations(["sales.nope"]);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).to.include("sales.nope");
      return;
    }
    throw new Error("DescribeRelations was expected to refuse");
  });

  it("offers only declarations registration takes: a schema written from its first offers registers", async () => {
    const generated = Generated(await Mappable());
    new Schema(SALES, generated);
    await WaitForSchemaReady(SALES);
    expect(Object.keys(GetSchema(SALES))).to.have.members(
      Object.keys(generated),
    );
  });
});

describe("the privileges the catalog reports", function () {
  this.timeout(120_000);

  it("keeps apart relations whose names differ only by case", async () => {
    const listed = await ListRelations([SALES]);
    expect(Named(listed, "countries")).to.not.have.property("unmappable");
    expect(Named(listed, "COUNTRIES").unmappable).to.match(/cannot SELECT/);
  });

  it("counts a SELECT the account holds only through a role of a role", async () => {
    expect(
      Named(await ListRelations([SALES]), "accounts"),
    ).to.not.have.property("unmappable");
  });

  it("reports what the connected account may write, through the role it holds", async () => {
    const listed = await ListRelations([SALES]);
    expect(Named(listed, "w_accounts").writes).to.deep.equal({
      insert: true,
      update: true,
      delete: true,
    });
    expect(Named(listed, "people").writes).to.deep.equal({
      insert: false,
      update: false,
      delete: false,
    });
    expect(Named(listed, "accounts").writes).to.deep.equal({
      insert: false,
      update: false,
      delete: false,
    });
  });
});

describe("a profile of an external relation", function () {
  this.timeout(120_000);

  let profiles: RelationProfile[];

  before(async () => {
    profiles = [];
    for (const relation of await Mappable()) {
      profiles.push(await Profile({ relation: `${SALES}.${relation.name}` }));
    }
  });

  function Of(name: string): RelationProfile {
    const found = profiles.find(
      (profile) => profile.relation === `${SALES}.${name}`,
    );
    if (!found) throw new Error(`no profile of ${name}`);
    return found;
  }

  it("never answers a text value, a text extreme or a value counted fewer than 5 times", () => {
    const answered = JSON.stringify(profiles);
    expect(answered).to.not.match(/@Example\.com/i);
    expect(answered).to.not.include("Acct ");
    expect(answered).to.not.include("First1");
    expect(answered).to.not.include("disputed");
  });

  it("answers an enum's categories with their counts", async () => {
    const status = Of("accounts").columns.find(
      (column) => column.name === "status",
    );
    expect(status?.traits).to.include("enum-like");
    const native = await Native(
      sql`SELECT CAST(status AS CHAR) AS status, COUNT(*) AS n FROM sales.accounts GROUP BY 1`,
    );
    expect(status?.categories).to.deep.include({ status: "ok" });
    const value =
      status?.categories?.status === "ok" ? status.categories.value : undefined;
    for (const row of native) {
      expect(value?.values).to.deep.include({
        value: row.status,
        rows: Number(row.n),
      });
    }
  });

  it("folds a value seen fewer than 5 times into other", () => {
    const kind = Of("invoices").columns.find(
      (column) => column.name === "kind",
    );
    expect(kind?.traits).to.include("enum-like");
    expect(kind?.categories).to.deep.include({ status: "ok" });
    if (kind?.categories?.status === "ok") {
      expect(kind.categories.value.other).to.equal(2);
      expect(kind.categories.value.values).to.have.length(3);
    }
  });

  it("finds a label, a time axis and a measure", () => {
    const columns = Of("accounts").columns;
    const traits = (name: string) =>
      columns.find((column) => column.name === name)?.traits;
    expect(traits("name")).to.include("label-candidate");
    expect(traits("created_at")).to.include("time-axis");
    expect(traits("revenue")).to.include("measure");
    expect(traits("id")).to.not.include("measure");
  });

  it("counts children per parent over a foreign key", async () => {
    const [reference] = Of("contacts").references;
    expect(reference.fanOut).to.deep.include({ status: "ok" });
    const parents = await NativeCount(
      sql`SELECT COUNT(DISTINCT account_id) FROM sales.contacts`,
    );
    if (reference.fanOut.status === "ok") {
      expect(reference.fanOut.value.average).to.be.closeTo(
        20000 / parents,
        1e-9,
      );
    }
  });

  it("samples a relation above the threshold, and says so", async () => {
    const big = await Profile({ relation: "sales.big_events" });
    expect(big.sample).to.not.equal(null);
    expect(big.sample?.rows).to.be.above(0).and.below(SAMPLE_THRESHOLD);
    expect(big.rows.status).to.equal("ok");
    if (big.rows.status === "ok") {
      expect(big.rows.value.exact).to.equal(false);
      expect(big.rows.value.rows).to.be.closeTo(
        BIG_EVENTS_ROWS,
        BIG_EVENTS_ROWS * ESTIMATE_TOLERANCE,
      );
    }
  });

  it("answers timeout for a measure past its time, and still answers the profile", async () => {
    SetMeasureTimeoutForTests(1);
    try {
      const big = await Profile({
        relation: "sales.big_events",
        columns: ["kind"],
      });
      const [kind] = big.columns;
      expect(kind.distinct).to.deep.equal({ status: "timeout" });
    } finally {
      SetMeasureTimeoutForTests();
    }
    const again = await Profile({
      relation: "sales.big_events",
      columns: ["kind"],
    });
    expect(again.columns[0].distinct?.status).to.equal("ok");
  });

  it("writes nothing, even through an account that may write", async () => {
    const outcome = await WithMeasures((session) =>
      session.measure(sql`INSERT INTO sales.w_big VALUES (987654321, 'x')`),
    );
    expect(outcome).to.deep.equal({ status: "error", code: "1792" });
    expect(
      await NativeCount(
        sql`SELECT COUNT(*) FROM sales.w_big WHERE id = 987654321`,
      ),
    ).to.equal(0);
  });
});

describe("a sample of rows", function () {
  this.timeout(60_000);

  it("answers every value as text, cut at 200 characters", async () => {
    const sample = await SampleRows({
      relation: "sales.attachments",
      columns: ["id", "note"],
      limit: 20,
    });
    expect(sample.columns).to.deep.equal(["id", "note"]);
    expect(sample.sample).to.equal(null);
    const byId = new Map(
      sample.rows.map((row) => [JSON.stringify(row[0]), row[1]]),
    );
    expect(
      byId.get(JSON.stringify({ text: "1", truncated: false })),
    ).to.deep.equal({ text: "n".repeat(200), truncated: true });
    expect(
      byId.get(JSON.stringify({ text: "2", truncated: false })),
    ).to.deep.equal({ text: "short", truncated: false });
    expect(byId.get(JSON.stringify({ text: "3", truncated: false }))).to.equal(
      null,
    );
  });

  it("answers a binary value by its length only", async () => {
    const sample = await SampleRows({
      relation: "sales.attachments",
      columns: ["body"],
      limit: 20,
    });
    expect(sample.rows.map((row) => row[0])).to.have.deep.members([
      { bytes: 4 },
      null,
      { bytes: 1 },
    ]);
  });

  it("answers at most the rows asked for, and refuses more than 20", async () => {
    const sample = await SampleRows({ relation: "sales.accounts", limit: 3 });
    expect(sample.rows).to.have.length(3);
    let refused: Error | undefined;
    try {
      await SampleRows({ relation: "sales.accounts", limit: 21 });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      refused = error;
    }
    expect(refused?.message).to.match(/from 1 to 20 rows/);
  });

  it("samples a relation above the threshold, and says so", async () => {
    const sample = await SampleRows({
      relation: "sales.big_events",
      limit: 5,
    });
    expect(sample.sample).to.not.equal(null);
    expect(sample.rows).to.have.length(5);
  });

  it("refuses a relation the account can read only in part", async () => {
    let refused: Error | undefined;
    try {
      await SampleRows({ relation: "sales.people", limit: 5 });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      refused = error;
    }
    expect(refused?.message).to.match(/cannot be read/);
  });
});

describe("a reference the database does not declare", function () {
  this.timeout(60_000);

  it("is found whole when every value is in the target's key", async () => {
    const match = await CheckReference({
      from: { relation: "sales.invoices", column: "account_ref" },
      to: { relation: "sales.accounts", column: "id" },
    });
    expect(match).to.deep.equal({
      status: "ok",
      value: {
        containment: 1,
        checkedRows: 1000,
        sampled: false,
        targetIsKey: true,
      },
    });
  });

  it("is found in part when some values have no target", async () => {
    const match = await CheckReference({
      from: { relation: "sales.invoices", column: "broken_ref" },
      to: { relation: "sales.accounts", column: "id" },
    });
    expect(match.status).to.equal("ok");
    if (match.status === "ok") {
      expect(match.value.containment).to.equal(0.75);
    }
  });
});

describe("the catalog outside development", () => {
  it("refuses when the catalog is not enabled", async () => {
    const options = GetOptions();
    const enabled = options.catalog.enabled;
    options.catalog.enabled = false;
    try {
      await Info();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).to.match(/development tool/);
      return;
    } finally {
      options.catalog.enabled = enabled;
    }
    throw new Error("Info was expected to refuse");
  });
});
