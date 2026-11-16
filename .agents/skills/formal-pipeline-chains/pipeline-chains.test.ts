import { expect } from "chai";
import fc from "fast-check";

import { EngineOf } from "./engine";
import { Run } from "./build";
import { ExpectedFailure } from "./expected";
import { Bounds } from "./bounds";
import { DRAW, Resolve } from "./draw";
import {
  Answered,
  Canonical,
  type Doc,
  IsList,
  IsMembers,
  type Json,
} from "./model";
import { Fixture, ITEMS, TABLES } from "./seed";

const fixture = Fixture("pipeline_chains");

/** Rows in no defined order compare as the sorted lists of their texts. */
function Unordered(value: Json): Json {
  return IsList(value) ? value.map(Canonical).sort() : value;
}

function Compared(value: Json, nested: boolean, ordered: boolean): Json {
  if (ordered) {
    return value;
  }
  if (!nested) {
    return Unordered(value);
  }
  return IsList(value)
    ? value.map((owner) =>
        IsMembers(owner) ? { ...owner, rows: Unordered(owner.rows) } : owner,
      )
    : value;
}

/**
 * Every engine answers a chain of stages as an in-memory evaluator of the documented semantics
 * does: row for row, and in order wherever the chain's order is defined. The chains are drawn
 * over filter, merge, orderBy, slice, nth, group, lookup, union, pluck and without, alone and for
 * each owner of a nested query that reads its outer row.
 *
 * It fails on a compiler that reads the outer row through a derived table MariaDB cannot correlate
 * (unknown column `t0.take`, #4 and #9), that loses the order of the rows a stage wraps (#16, #28),
 * that cannot resolve a walk of a merged object on MySQL 8.4 (#60, #68) or that reads another
 * group's rows (#86).
 */
describe("a chain of stages on a real server", function () {
  this.timeout(600_000);

  before(() => fixture.seed(ITEMS));
  after(() => fixture.unseed());

  it("answers as the reference evaluator does", async () => {
    await fc.assert(
      fc.asyncProperty(DRAW, async (draw) => {
        const chain = Resolve(draw);
        const expected = Answered(chain, TABLES);
        const read = await Run(
          fixture.handles,
          chain.stages,
          chain.terminal,
          chain.nested,
        );
        const answer = read ?? null;
        const ordered = chain.ordered && chain.terminal.kind === "rows";
        expect(
          Compared(answer, chain.nested, ordered),
          JSON.stringify({ chain, expected, answer }),
        ).to.deep.equal(Compared(expected, chain.nested, ordered));
      }),
      Bounds("CHAINS_RUNS", 1000),
    );
  });

  /**
   * `pluck` drops a member that holds a JSON null, so `{ k: null }` comes back as `{}` where `k`
   * holds the key of a group with no kind, the label of no owner or a lookup that found none.
   * `draw.ts` keeps `pluck` off a field that can hold a null until the module answers `{ k: null }`.
   */
  it("keeps a member that holds a null in the document a pluck answers", async () => {
    await ExpectedFailure(async () => {
      const rows = await fixture.handles
        .items()
        .cast<Doc>()
        .map((row) => ({ k: row.key("kind") }))
        .pluck("k")
        .run();
      expect(rows).to.have.lengthOf(ITEMS.length);
      for (const row of rows) {
        expect(row).to.have.property("k");
      }
    });
  });

  /**
   * On MariaDB 11.8 `nth` of an ordered, merged chain that filters on the outer owner answers `null`
   * for every owner but the first; MySQL answers each owner's row. `draw.ts` draws no `nth` after a
   * `merge` and a `filterOuter` until MariaDB answers it.
   */
  it("takes the nth row of a merged chain that filters on the outer owner", async () => {
    if ((await EngineOf()) !== "mariadb") {
      return;
    }
    await ExpectedFailure(async () => {
      const chain = {
        nested: true,
        stages: [
          { kind: "orderBy", field: "slug", direction: "asc" },
          {
            kind: "merge",
            name: "m",
            expression: { kind: "number", value: 0 },
          },
          { kind: "filterOuter", field: "n", compare: "eq" },
        ],
        terminal: { kind: "nth", at: 0 },
      } as const;
      const read = await Run(
        fixture.handles,
        chain.stages,
        chain.terminal,
        chain.nested,
      );
      expect(read).to.deep.equal(Answered(chain, TABLES));
    });
  });
});
