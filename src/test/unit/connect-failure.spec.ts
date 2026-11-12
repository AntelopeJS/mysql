import { expect } from "chai";

import { DescribeConnectFailure } from "../../connect-failure";

const URL = "mysql://reader:secret@client-db:6543/erp";
const URL_WITHOUT_PORT = "mysql://reader:secret@client-db/erp";

function Coded(code: string, message = "driver message"): Error {
  return Object.assign(new Error(message), { code });
}

describe("DescribeConnectFailure", () => {
  const CASES = [
    {
      code: "ER_ACCESS_DENIED_ERROR",
      expected: "wrong user or password (ER_ACCESS_DENIED_ERROR)",
    },
    {
      code: "ER_BAD_DB_ERROR",
      expected: "the database does not exist (ER_BAD_DB_ERROR)",
    },
    {
      code: "ER_DBACCESS_DENIED_ERROR",
      expected:
        "the user may not use the database, or it does not exist (ER_DBACCESS_DENIED_ERROR)",
    },
    {
      code: "ER_SECURE_TRANSPORT_REQUIRED",
      expected: "the server requires SSL (ER_SECURE_TRANSPORT_REQUIRED)",
    },
    {
      code: "ECONNREFUSED",
      expected: "the server is not answering at client-db:6543 (ECONNREFUSED)",
    },
    {
      code: "ENOTFOUND",
      expected: "the server is not answering at client-db:6543 (ENOTFOUND)",
    },
    {
      code: "ETIMEDOUT",
      expected: "the server is not answering at client-db:6543 (ETIMEDOUT)",
    },
  ];

  for (const { code, expected } of CASES) {
    it(`words ${code} as one sentence and keeps the code`, () => {
      expect(DescribeConnectFailure(Coded(code), URL)).to.equal(expected);
    });
  }

  it("names the default port when the URL has none", () => {
    expect(
      DescribeConnectFailure(Coded("ECONNREFUSED"), URL_WITHOUT_PORT),
    ).to.equal("the server is not answering at client-db:3306 (ECONNREFUSED)");
  });

  it("keeps an unmapped code with the driver's message", () => {
    expect(
      DescribeConnectFailure(
        Coded("ER_CON_COUNT_ERROR", "Too many connections"),
        URL,
      ),
    ).to.equal("Too many connections (ER_CON_COUNT_ERROR)");
  });

  it("keeps the message of an error without a code", () => {
    expect(DescribeConnectFailure(new Error("socket hang up"), URL)).to.equal(
      "socket hang up",
    );
  });
});
