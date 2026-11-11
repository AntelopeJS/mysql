import { expect } from "chai";
import { DuplicateKeyError } from "@antelopejs/interface-database";

import { DIALECTS } from "../../dialect";
import { DuplicateKeyFailure } from "../../implementations/database/duplicate-key";
import { ExecuteAtomicWrite } from "../../implementations/database/writes-atomic";
import { WithForeign } from "./spec-fixture";
import { PlanOf } from "./pipeline-fixture";
import type { TableOrigin } from "../../implementations/database/relation";

function classify(error: Error) {
  return DIALECTS.mysql.errors.classify(error);
}

/** An error as the driver raises one the server answered. */
function ServerError(errno: number, message: string): Error {
  const error = WithForeign(new Error(message), "errno", errno);
  return WithForeign(error, "sqlState", "23000");
}

const PEOPLE: TableOrigin = {
  schemaId: "directory",
  tableId: "people",
  model: { fields: {} },
  plan: PlanOf("people"),
  index: (name) => [name],
};

describe("A driver error", () => {
  it("names the key a duplicate entry was refused by, quotes in the value and all", () => {
    expect(
      classify(
        ServerError(
          1062,
          "Duplicate entry 'it's' for key 'directory__people.title'",
        ),
      ),
    ).to.deep.equal({ kind: "duplicate", key: "directory__people.title" });
  });

  it("reads a deadlock and a lock wait as worth another attempt", () => {
    expect(classify(ServerError(1213, "Deadlock found"))).to.deep.equal({
      kind: "retry",
    });
    expect(
      classify(ServerError(1205, "Lock wait timeout exceeded")),
    ).to.deep.equal({ kind: "retry" });
  });

  it("reads an error with no SQL state, or one that ended the connection, as the connection's", () => {
    expect(
      classify(WithForeign(new Error("read ECONNRESET"), "errno", -104)),
    ).to.deep.equal({
      kind: "connection",
    });
    const fatal = WithForeign(
      ServerError(1053, "Server shutdown"),
      "fatal",
      true,
    );
    expect(classify(fatal)).to.deep.equal({ kind: "connection" });
  });
});

describe("A failed write", () => {
  it("answers a declared unique index's duplicate by the index and its fields", () => {
    const failure = DuplicateKeyFailure(
      ServerError(
        1062,
        "Duplicate entry 'Dr' for key 'directory__people.title'",
      ),
      PEOPLE,
      DIALECTS.mysql,
    );
    expect(failure).to.be.instanceOf(DuplicateKeyError);
    expect(failure.message).to.include("title");
  });

  it("answers the primary key's duplicate as _id", () => {
    const failure = DuplicateKeyFailure(
      ServerError(
        1062,
        "Duplicate entry '-a' for key 'directory__people.PRIMARY'",
      ),
      PEOPLE,
      DIALECTS.mysql,
    );
    expect(failure).to.be.instanceOf(DuplicateKeyError);
    expect(failure.message).to.include("_id");
  });

  it("leaves a duplicate on an index it did not declare unchanged", () => {
    const error = ServerError(
      1062,
      "Duplicate entry 'x' for key 'directory__people.other'",
    );
    expect(DuplicateKeyFailure(error, PEOPLE, DIALECTS.mysql)).to.equal(error);
  });

  it("names the field and the width when a value is too wide for a unique index's key", () => {
    const key = PlanOf("people").keyColumns.find(
      (column) => column.source === "meta",
    );
    const failure = DuplicateKeyFailure(
      ServerError(
        1406,
        `Data too long for column '${key?.name ?? ""}' at row 1`,
      ),
      PEOPLE,
      DIALECTS.mysql,
    );
    expect(failure.message).to.match(
      /'meta\.title' is longer than \d+ characters unique index 'title'/,
    );
  });
});

describe("An atomic mutation's outcome", () => {
  it("is applied for a matched row and not applied for none", async () => {
    expect(
      await ExecuteAtomicWrite(DIALECTS.mysql, () => Promise.resolve(1)),
    ).to.equal("applied");
    expect(
      await ExecuteAtomicWrite(DIALECTS.mysql, () => Promise.resolve(0)),
    ).to.equal("not-applied");
  });

  it("is unknown when the connection failed, since the write may have committed", async () => {
    const lost = WithForeign(new Error("Connection lost"), "fatal", true);
    expect(
      await ExecuteAtomicWrite(DIALECTS.mysql, () => Promise.reject(lost)),
    ).to.equal("unknown");
  });

  it("rethrows an error the server answered, since the statement did not apply", async () => {
    const refused = ServerError(1406, "Data too long");
    const outcome = ExecuteAtomicWrite(DIALECTS.mysql, () =>
      Promise.reject(refused),
    );
    let thrown: unknown;
    try {
      await outcome;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).to.equal(refused);
  });
});
