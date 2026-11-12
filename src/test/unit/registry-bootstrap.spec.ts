import { expect } from "chai";

import { Bind, sql } from "../../statement";
import { DIALECTS } from "../../dialect";
import { ApplyRegistry } from "../../implementations/database/migrate-tables";
import type { ConvergenceSession } from "../../implementations/database/locks";

function ServerError(errno: number): Error {
  return Object.assign(new Error(`server error ${errno}`), {
    errno,
    sqlState: "HY000",
  });
}

/** A session whose `apply` fails with `failures`, in order, then runs every statement it gets. */
function Failing(failures: Error[], ran: string[]): ConvergenceSession {
  const pending = [...failures];
  return {
    id: 1,
    read: () => Promise.resolve([]),
    write: () => Promise.resolve(0),
    apply: (statement) => {
      const failure = pending.shift();
      if (failure) {
        return Promise.reject(failure);
      }
      ran.push(Bind(statement).sql);
      return Promise.resolve(0);
    },
  };
}

const STATEMENTS = [
  sql`CREATE TABLE a (x INT)`,
  sql`INSERT IGNORE INTO a VALUES (1)`,
];

describe("the registry bootstrap a tables phase runs first", () => {
  it("runs a statement again after another session's deadlock, then the rest", async () => {
    const ran: string[] = [];
    await ApplyRegistry(
      DIALECTS.mysql,
      Failing([ServerError(1213)], ran),
      STATEMENTS,
    );
    expect(ran).to.deep.equal([
      "CREATE TABLE a (x INT)",
      "INSERT IGNORE INTO a VALUES (1)",
    ]);
  });

  it("runs a statement again after a lock wait that timed out", async () => {
    const ran: string[] = [];
    await ApplyRegistry(
      DIALECTS.mysql,
      Failing([ServerError(1205), ServerError(1205)], ran),
      STATEMENTS,
    );
    expect(ran).to.have.length(2);
  });

  it("refuses at once on an error a retry cannot clear", async () => {
    const ran: string[] = [];
    const refusal = ServerError(1064);
    const failed = await ApplyRegistry(
      DIALECTS.mysql,
      Failing([refusal], ran),
      STATEMENTS,
    ).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failed).to.equal(refusal);
    expect(ran).to.deep.equal([]);
  });
});
