import { expect } from "chai";
import { ListRelations } from "@antelopejs/interface-database-catalog";

import { GetOptions } from "../config";
import { probe } from "../probe";
import { CLIENT_DATABASE, CLIENT_USER } from "./fixture";

const TIMEOUT_MS = 5000;

describe("probe, beside the catalog", function () {
  this.timeout(TIMEOUT_MS * 3);

  /** Fails on a probe that decides a relation's access otherwise than the catalog lists it. */
  it("answers the access the catalog lists for the account the instance connects as", async () => {
    const relations = await ListRelations([CLIENT_DATABASE]);
    const answer = await probe({
      url: GetOptions().url ?? "",
      timeoutMs: TIMEOUT_MS,
      signal: new AbortController().signal,
    });
    expect(answer).to.deep.include({
      outcome: "signed-in",
      user: `${CLIENT_USER}@%`,
      canRead:
        relations.length === 0 ||
        relations.some((relation) => relation.unmappable === undefined),
      canWrite: relations.some(
        ({ writes }) => writes.insert || writes.update || writes.delete,
      ),
    });
  });
});
