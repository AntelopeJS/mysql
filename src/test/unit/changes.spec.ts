import { expect } from "chai";
import type { TableDefinition } from "@antelopejs/interface-database/schema";

import { Bind } from "../../statement";
import { DIALECTS, type ObservedTable } from "../../dialect";
import { ParseTable } from "../../implementations/database/fields";
import {
  BuildTablePlan,
  type TablePlan,
} from "../../implementations/database/plan";
import {
  ApplyTriggerSwap,
  CapturedColumns,
  EnsureTriggers,
  PlanTriggerSwap,
  type TriggerSwap,
} from "../../implementations/database/change-log";
import type { ConvergenceSession } from "../../implementations/database/locks";
import { CatalogColumns } from "./catalog-fixture";

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

/** The table as the catalog reports it once `plan` converged, with `more` columns after the plan's. */
function Observed(
  plan: TablePlan,
  more: ObservedTable["columns"] = [],
): ObservedTable {
  return {
    kind: "table",
    comment: "",
    columns: [...CatalogColumns(plan), ...more],
    indexes: [],
    triggers: [],
  };
}

/** The swap of `plan`'s table, logging what the catalog reports once it converged. */
function Swap(
  plan: TablePlan,
  triggers: readonly string[],
  intent: "converge" | "install",
): TriggerSwap | undefined {
  const captured = CapturedColumns(MYSQL, Observed(plan), new Set());
  return PlanTriggerSwap(MYSQL, plan.table, captured, triggers, intent);
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
  return Created(Swap(plan, [], "install"));
}

/** The statements a first install creates, one per event, in the order it creates them. */
function Bodies(plan: TablePlan) {
  const [INSERT, UPDATE, DELETE] = Texts(Swap(plan, [], "install"));
  return { INSERT, UPDATE, DELETE };
}

describe("the change log's triggers", () => {
  const plan = Plan(ITEMS);
  const bodies = Bodies(plan);

  it("logs a JSON-backed column as its text, which nests no deeper than the column and keeps SQL NULL apart from JSON null", () => {
    for (const column of ["meta", "_extra"]) {
      expect(bodies.INSERT).to.contain(`CAST(NEW.\`${column}\` AS CHAR)`);
    }
    expect(bodies.INSERT).to.not.contain("CAST(NEW.`price` AS CHAR)");
  });

  it("logs an update only when some column changed, comparing every column null-safely, unless the session moves values", () => {
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
    expect(bodies.UPDATE).to.contain(
      "FOR EACH ROW IF @antelopejs_moving IS NULL AND NOT (",
    );
    expect(bodies.INSERT).to.not.contain("@antelopejs_moving");
    expect(bodies.DELETE).to.not.contain("@antelopejs_moving");
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
    const swap = Swap(plan, [], "install");
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
    expect(Swap(plan, [], "converge")).to.equal(undefined);
    expect(Swap(plan, ["audit_insert"], "converge")).to.equal(undefined);
  });

  it("does nothing once a watched table's triggers match its plan", () => {
    expect(Swap(plan, desired, "converge")).to.equal(undefined);
  });

  it("names the triggers after what they log, so a new column is a new set of names", () => {
    const next = Desired(wider);
    expect(next).to.have.length(3);
    expect(next.filter((name) => desired.includes(name))).to.deep.equal([]);
  });

  it("creates the new triggers before it drops the old ones, so a crash part way leaves duplicates rather than a gap", () => {
    const swap = Swap(wider, desired, "converge");
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
    const swap = Swap(wider, [...desired, next[0]], "converge");
    expect(Created(swap)).to.deep.equal(next.slice(1));
    expect(Dropped(swap)).to.deep.equal(desired);
  });

  it("never drops a trigger another tool made", () => {
    const swap = Swap(wider, ["audit_insert", ...desired], "converge");
    expect(Dropped(swap)).to.not.include("audit_insert");
  });

  it("accepts on install a complete set an older plan made, which only convergence replaces", () => {
    expect(Swap(wider, desired, "install")).to.equal(undefined);
  });

  it("completes on install a set that lacks an operation, replacing what was there", () => {
    const swap = Swap(wider, [desired[0]], "install");
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

describe("the columns a table's triggers log", () => {
  const plan = Plan(ITEMS);

  it("are every column the catalog reports but a generated one, one of a type no field has, and one being dropped", () => {
    const observed = Observed(plan, [
      { name: "key_name", type: "varchar(640)", generated: true, comment: "" },
      { name: "legacy", type: "mediumblob", generated: false, comment: "" },
    ]);
    const logged = CapturedColumns(MYSQL, observed, new Set(["price"]));
    expect(logged.map((column) => column.name)).to.deep.equal(
      plan.columns
        .map((column) => column.name)
        .filter((name) => name !== "price"),
    );
  });
});

describe("applying a table's trigger swap", () => {
  const planned = Swap(Plan(ITEMS), [], "install");
  if (!planned) {
    throw new Error("a table without triggers needs a swap");
  }
  const swap: TriggerSwap = planned;

  function ServerRefusal(errno: number): Error {
    return Object.assign(new Error(`server error ${errno}`), {
      errno,
      sqlState: "HY000",
    });
  }

  /** A session that runs every statement except a trigger's creation, which fails with `failure`. */
  function Refusing(failure: Error, ran: string[]): ConvergenceSession {
    return {
      id: 1,
      read: () => Promise.resolve([]),
      write: () => Promise.resolve(0),
      apply: (statement) => {
        const text = Bind(statement).sql;
        ran.push(text);
        return text.startsWith("CREATE TRIGGER")
          ? Promise.reject(failure)
          : Promise.resolve(0);
      },
    };
  }

  async function Failure(failure: Error, ran: string[]): Promise<Error> {
    try {
      await ApplyTriggerSwap(Refusing(failure, ran), swap);
    } catch (err) {
      if (err instanceof Error) {
        return err;
      }
      throw err;
    }
    return expect.fail("the creation of a trigger was refused");
  }

  it("words the server's refusal for want of SUPER, keeps it as the cause, and gives the table back", async () => {
    const ran: string[] = [];
    const refusal = ServerRefusal(1419);
    const err = await Failure(refusal, ran);
    expect(err).to.have.property("cause", refusal);
    expect(err).to.have.property("message").that.includes("GRANT SUPER ON *.*");
    expect(ran.at(-1)).to.equal(Bind(swap.unlock).sql);
  });

  it("passes every other failure through as it came", async () => {
    const denied = ServerRefusal(1142);
    expect(await Failure(denied, [])).to.equal(denied);
  });
});
