import { expect } from "chai";

import { DIALECTS } from "../../dialect";
import type { CheckedValue } from "../../dialect/external";
import { Bind } from "../../statement";
import { ParseFieldType } from "../../implementations/database/fields";
import {
  Describe,
  DescribeKey,
} from "../../implementations/database/external-types";
import { AcceptedDeclarations } from "../../implementations/database/external-declarations";
import { Column } from "./external-fixture";

const mysql = DIALECTS.mysql;

function Kind(declared: string) {
  return ParseFieldType(declared, "field").type;
}

function Read(native: string, declared: string): string {
  const descriptor = Describe(
    mysql,
    "c",
    Kind(declared),
    Column("c", native),
    "sales.t.c",
  );
  return Bind(descriptor.value(mysql.sql.quote("c"))).sql;
}

const READINGS: [string, string, string][] = [
  ["varchar(200)", "string", "`c`"],
  ["enum('a','b')", "string", "`c`"],
  ["bigint", "string", "CAST(`c` AS CHAR)"],
  ["decimal(12,2)", "number", "CAST(`c` AS DOUBLE)"],
  ["double", "number", "`c`"],
  ["tinyint(1)", "boolean", "(`c` <> 0)"],
  [
    "datetime(6)",
    "date",
    "IF((MONTH(`c`) <> 0 AND DAYOFMONTH(`c`) <> 0), `c`, NULL)",
  ],
  [
    "date",
    "date",
    "IF((MONTH(`c`) <> 0 AND DAYOFMONTH(`c`) <> 0), CAST(`c` AS DATETIME(6)), NULL)",
  ],
  ["json", "object", "`c`"],
  ["json", "string[]", "`c`"],
];

const LOSSY: [string, string, RegExp | undefined][] = [
  ["bigint", "number", /2\^53/],
  ["bigint unsigned", "string", undefined],
  ["decimal(12,2)", "number", /DECIMAL/],
  ["float", "number", /FLOAT/],
  ["datetime", "date", /UTC/],
  ["datetime(6)", "date", /microseconds/],
  ["timestamp", "date", undefined],
  ["timestamp(6)", "date", /microseconds/],
  ["int", "number", undefined],
];

const REFUSED: [string, string, string][] = [
  ["char(36)", "number", "declare it as string"],
  ["blob", "string", "no field type reads it"],
  ["varchar(10)", "date", "declare it as string"],
  ["geometry", "object", "no field type reads it"],
];

describe("external column readings", () => {
  for (const [native, declared, value] of READINGS) {
    it(`reads ${native} declared ${declared} as ${value}`, () => {
      expect(Read(native, declared)).to.equal(value);
    });
  }

  for (const [native, declared, lossy] of LOSSY) {
    it(`accepts ${native} declared ${declared}${lossy ? ", saying what it loses" : " without loss"}`, () => {
      const descriptor = Describe(
        mysql,
        "c",
        Kind(declared),
        Column("c", native),
        "sales.t.c",
      );
      if (lossy) {
        expect(descriptor.lossy).to.match(lossy);
      } else {
        expect(descriptor.lossy).to.equal(undefined);
      }
    });
  }

  for (const [native, declared, fix] of REFUSED) {
    it(`refuses a ${declared} field over ${native}, naming field, column and the fix`, () => {
      expect(() =>
        Describe(mysql, "c", Kind(declared), Column("c", native), "sales.t.c"),
      )
        .to.throw("sales.t.c")
        .with.property("message")
        .that.contains(native)
        .and.contains(fix);
    });
  }

  it("leaves a generated column and a SET column unwritten, saying why", () => {
    const generated = Describe(
      mysql,
      "c",
      Kind("string"),
      Column("c", "varchar(5)", { generated: true }),
      "sales.t.c",
    );
    const set = Describe(
      mysql,
      "c",
      Kind("string"),
      Column("c", "set('r','w')"),
      "sales.t.c",
    );
    expect([generated.writing, generated.readOnly]).to.deep.equal([
      undefined,
      "a generated column",
    ]);
    expect(set.writing).to.equal(undefined);
    expect(set.readOnly).to.contain("set('r','w')");
  });
});

describe("declarations a catalog offers for a column", () => {
  function Offered(native: string): string[] {
    return AcceptedDeclarations(mysql, Column("c", native)).map(
      (accepted) => accepted.declared,
    );
  }

  it("proposes number over a bigint, and offers string beside it", () => {
    expect(Offered("bigint")).to.deep.equal(["number", "string"]);
  });

  it("proposes date over a datetime and string over an enum", () => {
    expect(Offered("datetime(6)")[0]).to.equal("date");
    expect(Offered("enum('a','b')")).to.deep.equal(["string"]);
  });

  it("proposes boolean over tinyint(1), which also reads as a number", () => {
    expect(Offered("tinyint(1)")).to.deep.equal(["boolean", "number"]);
  });

  it("offers nothing over a type no field type reads", () => {
    expect(Offered("varbinary(16)")).to.deep.equal([]);
  });

  it("offers only what registration takes", () => {
    for (const native of ["bigint", "json", "date", "set('a')", "year"]) {
      for (const accepted of AcceptedDeclarations(mysql, Column("c", native))) {
        expect(() =>
          Describe(mysql, "c", accepted.kind, Column("c", native), "t.c"),
        ).to.not.throw();
      }
    }
  });
});

describe("external key columns", () => {
  it("reads a date key as the server's text for _id", () => {
    const key = DescribeKey(mysql, Column("day", "date"));
    expect(key && Bind(key.value(mysql.sql.quote("day"))).sql).to.equal(
      "CAST(`day` AS CHAR)",
    );
  });

  it("offers no _id over a float or a JSON column, which is no identity", () => {
    expect(DescribeKey(mysql, Column("f", "double"))).to.equal(undefined);
    expect(DescribeKey(mysql, Column("j", "json"))).to.equal(undefined);
  });

  it("gives a type named after an Object.prototype member no family", () => {
    expect(mysql.external.types.family(Column("c", "constructor"))).to.equal(
      undefined,
    );
  });
});

describe("what a written value is checked against before an external write runs", () => {
  function Refusal(
    native: string,
    declared: string,
    value: CheckedValue,
    extra = {},
  ): string | undefined {
    const descriptor = Describe(
      mysql,
      "c",
      Kind(declared),
      Column("c", native, extra),
      "t.c",
    );
    return descriptor.check?.(value);
  }

  const REFUSED_VALUES: [string, string, CheckedValue][] = [
    ["varchar(5)", "string", { kind: "text", value: "toolong" }],
    ["char(2)", "string", { kind: "text", value: "abc" }],
    ["int", "number", { kind: "number", value: 5.5 }],
    ["tinyint", "number", { kind: "number", value: 128 }],
    ["int unsigned", "number", { kind: "number", value: -1 }],
    ["bigint", "string", { kind: "text", value: "42abc" }],
    ["bigint", "string", { kind: "text", value: "9223372036854775808" }],
    ["decimal(12,2)", "number", { kind: "number", value: 1e10 }],
    ["decimal(5,2)", "string", { kind: "text", value: "1234.5" }],
    ["timestamp", "date", { kind: "date", value: new Date("2040-01-01") }],
    ["date", "date", { kind: "date", value: new Date("0999-12-31") }],
  ];

  for (const [native, declared, value] of REFUSED_VALUES) {
    it(`refuses ${JSON.stringify(value.value)} for ${native} declared ${declared}`, () => {
      expect(Refusal(native, declared, value)).to.contain(native);
    });
  }

  const ACCEPTED_VALUES: [string, string, CheckedValue][] = [
    ["varchar(5)", "string", { kind: "text", value: "héllo" }],
    ["int", "number", { kind: "number", value: 5 }],
    [
      "bigint unsigned",
      "string",
      { kind: "text", value: "18446744073709551615" },
    ],
    ["decimal(12,2)", "number", { kind: "number", value: 1.234 }],
    ["timestamp", "date", { kind: "date", value: new Date("2038-01-01") }],
  ];

  for (const [native, declared, value] of ACCEPTED_VALUES) {
    it(`accepts ${JSON.stringify(value.value)} for ${native} declared ${declared}`, () => {
      expect(Refusal(native, declared, value)).to.equal(undefined);
    });
  }

  it("refuses an enum label the column does not list", () => {
    const labels = { enumLabels: ["lead", "active"] };
    expect(
      Refusal(
        "enum('lead','active')",
        "string",
        { kind: "text", value: "x" },
        labels,
      ),
    ).to.contain("labels");
    expect(
      Refusal(
        "enum('lead','active')",
        "string",
        { kind: "text", value: "lead" },
        labels,
      ),
    ).to.equal(undefined);
  });

  it("takes a label in another case only where the column's collation ignores case, as MySQL then stores the label", () => {
    const labels = { enumLabels: ["Red", "Green"], charset: "utf8mb4" };
    const red = { kind: "text", value: "red" } as const;
    const refusals = ["utf8mb4_0900_ai_ci", "utf8mb4_bin"].map((collation) =>
      Refusal("enum('Red','Green')", "string", red, {
        ...labels,
        collation,
      }),
    );
    expect(refusals[0]).to.equal(undefined);
    expect(refusals[1]).to.contain("labels");
  });
});

describe("what a refused external write means", () => {
  function Failed(errno: number, message: string) {
    return mysql.external.failure(Object.assign(new Error(message), { errno }));
  }

  it("reads the column, index and constraint the server's English messages name", () => {
    expect(Failed(1048, "Column 'qty' cannot be null")).to.include({
      kind: "missing",
      column: "qty",
    });
    expect(
      Failed(
        1062,
        "Duplicate entry 'e1' for key 'w_accounts.w_accounts_code_key'",
      ),
    ).to.include({
      kind: "duplicate",
      constraint: "w_accounts.w_accounts_code_key",
    });
    expect(
      Failed(
        1451,
        "Cannot delete or update a parent row: a foreign key constraint fails (`s`.`i`, CONSTRAINT `i_fk` FOREIGN KEY (`a`) REFERENCES `a` (`id`))",
      ),
    ).to.include({ kind: "referenced", constraint: "i_fk" });
    expect(Failed(3819, "Check constraint 'a_rev' is violated.")).to.include({
      kind: "check",
      constraint: "a_rev",
    });
    expect(Failed(1406, "Data too long for column 'code' at row 1")).to.include(
      {
        kind: "invalid",
        column: "code",
      },
    );
  });

  it("tells a missing referenced row from a row still referenced by errno alone", () => {
    expect(Failed(1452, "")?.kind).to.equal("reference");
    expect(Failed(1451, "")?.kind).to.equal("referenced");
  });

  it("leaves any other error as it is", () => {
    expect(Failed(1213, "Deadlock found")).to.equal(undefined);
    expect(mysql.external.failure(new Error("socket hang up"))).to.equal(
      undefined,
    );
  });
});
