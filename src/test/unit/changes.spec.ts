import { expect } from "chai";
import type { TableDefinition } from "@antelopejs/interface-database/schema";

import { Bind } from "../../statement";
import { DIALECTS } from "../../dialect";
import { ParseTable } from "../../implementations/database/fields";
import {
  BuildTablePlan,
  type TablePlan,
} from "../../implementations/database/plan";
import {
  EnsureTriggers,
  PlanTriggerSwap,
  type TriggerSwap,
} from "../../implementations/database/change-log";

const MYSQL = DIALECTS.mysql;
const { capture } = MYSQL;

const ITEMS: TableDefinition = {
  fields: { name: "string", price: "number", meta: "object" },
  indexes: { name: {} },
};

const WIDER: TableDefinition = {
  fields: { ...ITEMS.fields, sold: "boolean" },
  indexes: ITEMS.indexes,
};

function Plan(definition: TableDefinition): TablePlan {
  return BuildTablePlan(
    "shop",
    "items",
    definition,
    ParseTable(definition, "shop.items"),
    { prefix: "", session: MYSQL.session },
  ).plan;
}

function Texts(swap: TriggerSwap | undefined): string[] {
  return (swap?.statements ?? []).map((statement) => Bind(statement).sql);
}

/** The trigger names a swap creates, in the order it creates them. */
function Created(swap: TriggerSwap | undefined): string[] {
  return Texts(swap).flatMap((text) => {
    const name = /^CREATE TRIGGER `([^`]+)`/.exec(text)?.[1];
    return name ? [name] : [];
  });
}

function Dropped(swap: TriggerSwap | undefined): string[] {
  return Texts(swap).flatMap((text) => {
    const name = /^DROP TRIGGER IF EXISTS `([^`]+)`/.exec(text)?.[1];
    return name ? [name] : [];
  });
}

/** The triggers a plan wants, as a first install creates them. */
function Desired(plan: TablePlan): string[] {
  return Created(PlanTriggerSwap(MYSQL, plan, [], "install"));
}

/** The statements a first install creates, one per event, in the order it creates them. */
function Bodies(plan: TablePlan) {
  const [INSERT, UPDATE, DELETE] = Texts(
    PlanTriggerSwap(MYSQL, plan, [], "install"),
  );
  return { INSERT, UPDATE, DELETE };
}

describe("the change log's triggers", () => {
  const plan = Plan(ITEMS);
  const bodies = Bodies(plan);

  it("boxes a JSON-backed column, so a column holding SQL NULL logs apart from one holding JSON null", () => {
    for (const column of ["meta", "_extra"]) {
      expect(bodies.INSERT).to.contain(
        `IF(NEW.\`${column}\` IS NULL, NULL, JSON_ARRAY(NEW.\`${column}\`))`,
      );
    }
    expect(bodies.INSERT).to.not.contain("JSON_ARRAY(NEW.`price`)");
  });

  it("logs an update only when some column changed, comparing every column null-safely", () => {
    for (const column of [
      "_id",
      "_instance",
      "name",
      "price",
      "meta",
      "_extra",
    ]) {
      expect(bodies.UPDATE).to.contain(
        `OLD.\`${column}\` <=> NEW.\`${column}\``,
      );
    }
    expect(bodies.UPDATE).to.contain("FOR EACH ROW IF NOT (");
  });

  it("names the table and the instance in every row it logs", () => {
    expect(bodies.INSERT).to.contain("'shop__items', NEW.`_instance`, 'added'");
    expect(bodies.DELETE).to.contain(
      "'shop__items', OLD.`_instance`, 'removed'",
    );
  });

  it("leaves a key column out of the image, since it is derived from the columns logged", () => {
    expect(plan.keyColumns).to.have.length.greaterThan(0);
    for (const key of plan.keyColumns) {
      expect(Object.values(bodies).join(" ")).to.not.contain(key.name);
    }
  });
});

describe("planning a table's trigger swap", () => {
  const plan = Plan(ITEMS);
  const wider = Plan(WIDER);
  const desired = Desired(plan);

  it("installs one trigger per operation on a table a feed watches first, under the table's lock", () => {
    const swap = PlanTriggerSwap(MYSQL, plan, [], "install");
    expect(desired).to.have.length(3);
    expect(
      Texts(swap).map((text) => / AFTER (\w+) /.exec(text)?.[1]),
    ).to.deep.equal(["INSERT", "UPDATE", "DELETE"]);
    expect(Bind(swap?.lock ?? capture.unlockTables).sql).to.equal(
      "LOCK TABLES `shop__items` WRITE",
    );
    expect(Bind(swap?.unlock ?? capture.lockTable("x")).sql).to.equal(
      "UNLOCK TABLES",
    );
  });

  it("leaves a table no feed ever watched alone when converging", () => {
    expect(PlanTriggerSwap(MYSQL, plan, [], "converge")).to.equal(undefined);
    expect(PlanTriggerSwap(MYSQL, plan, ["audit_insert"], "converge")).to.equal(
      undefined,
    );
  });

  it("does nothing once a watched table's triggers match its plan", () => {
    expect(PlanTriggerSwap(MYSQL, plan, desired, "converge")).to.equal(
      undefined,
    );
  });

  it("names the triggers after what they log, so a new column is a new set of names", () => {
    const next = Desired(wider);
    expect(next).to.have.length(3);
    expect(next.filter((name) => desired.includes(name))).to.deep.equal([]);
  });

  it("creates the new triggers before it drops the old ones, so a crash part way leaves duplicates rather than a gap", () => {
    const swap = PlanTriggerSwap(MYSQL, wider, desired, "converge");
    expect(Created(swap)).to.deep.equal(Desired(wider));
    expect(Dropped(swap)).to.deep.equal(desired);
    const texts = Texts(swap);
    const kinds = texts.map((text) => text.split(" ")[0]);
    expect(kinds).to.deep.equal([
      "CREATE",
      "CREATE",
      "CREATE",
      "DROP",
      "DROP",
      "DROP",
    ]);
  });

  it("finishes a swap a crash interrupted, from whatever triggers it left", () => {
    const next = Desired(wider);
    const swap = PlanTriggerSwap(
      MYSQL,
      wider,
      [...desired, next[0]],
      "converge",
    );
    expect(Created(swap)).to.deep.equal(next.slice(1));
    expect(Dropped(swap)).to.deep.equal(desired);
  });

  it("never drops a trigger another tool made", () => {
    const swap = PlanTriggerSwap(
      MYSQL,
      wider,
      ["audit_insert", ...desired],
      "converge",
    );
    expect(Dropped(swap)).to.not.include("audit_insert");
  });

  it("accepts on install a complete set an older plan made, which only convergence replaces", () => {
    expect(PlanTriggerSwap(MYSQL, wider, desired, "install")).to.equal(
      undefined,
    );
  });

  it("completes on install a set that lacks an operation, replacing what was there", () => {
    const swap = PlanTriggerSwap(MYSQL, wider, [desired[0]], "install");
    expect(Created(swap)).to.deep.equal(Desired(wider));
    expect(Dropped(swap)).to.deep.equal([desired[0]]);
  });
});

describe("installing a table's triggers for its first feed", () => {
  /**
   * A table no registration can create, so the install fails the same way with or without a live
   * adapter in the process: there is no connection, or there is no such table.
   */
  const absent: TablePlan = {
    ...Plan(ITEMS),
    schemaId: "__spec_absent",
    tableId: "__spec_absent",
    table: "__spec_absent__items",
  };

  it("shares one install between every feed that asks for a table at once", async () => {
    const first = EnsureTriggers(absent);
    const second = EnsureTriggers(absent);
    expect(second).to.equal(first);
    await first.then(
      () => expect.fail("this spec has no table to install onto"),
      () => undefined,
    );
  });

  it("does not remember an install that failed, so the next feed tries again", async () => {
    const failed = EnsureTriggers(absent);
    await failed.then(
      () => expect.fail("this spec has no table to install onto"),
      () => undefined,
    );
    const retried = EnsureTriggers(absent);
    expect(retried).to.not.equal(failed);
    await retried.then(
      () => expect.fail("this spec has no table to install onto"),
      () => undefined,
    );
  });
});
