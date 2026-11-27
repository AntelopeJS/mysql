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
