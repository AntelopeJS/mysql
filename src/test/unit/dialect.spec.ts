import { expect } from "chai";

import { Bind } from "../../statement";
import { DIALECTS, DetectDialect, IsDialectId } from "../../dialect";
import {
  ArrayOf,
  BOOL,
  FLOAT,
  JsonOf,
  OPAQUE,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";

const { session, sql: syntax } = DIALECTS.mysql;

function PinText(statementTimeoutMs?: number): string {
  const bound = Bind(session.pin({ statementTimeoutMs }));
  expect(bound.args).to.deep.equal([]);
  return bound.sql;
}

function SqlMode(pin: string): string[] {
  const match = /sql_mode = '([^']*)'/.exec(pin);
  expect(match, "the pin sets sql_mode").to.not.equal(null);
  return (match?.[1] ?? "").split(",");
}

describe("DetectDialect", () => {
  it("reads a MySQL version as mysql", () => {
    expect(DetectDialect("8.4.13")).to.equal("mysql");
    expect(DetectDialect("9.7.4")).to.equal("mysql");
  });

  it("refuses MariaDB by name until it has a dialect", () => {
    expect(() => DetectDialect("11.4.5-MariaDB-ubu2404")).to.throw(/mariadb/);
  });
});

describe("IsDialectId", () => {
  it("accepts a listed engine and refuses an inherited member", () => {
    expect(IsDialectId("mysql")).to.equal(true);
    expect(IsDialectId("toString")).to.equal(false);
  });
});

describe("the MySQL session pin", () => {
  it("is one statement pinning the collation, UTC and English messages", () => {
    const pin = PinText();
    expect(pin).to.match(/^SET NAMES utf8mb4 COLLATE 'utf8mb4_0900_bin', /);
    expect(pin).to.contain("time_zone = '+00:00'");
    expect(pin).to.contain("lc_messages = 'en_US'");
    expect(pin).to.contain("group_concat_max_len = 4294967295");
  });

  it("is strict and keeps backslash escapes, plain `||` and backtick identifiers", () => {
    const modes = SqlMode(PinText());
    expect(modes).to.include("STRICT_ALL_TABLES");
    expect(modes).to.not.include("NO_BACKSLASH_ESCAPES");
    expect(modes).to.not.include("PIPES_AS_CONCAT");
    expect(modes).to.not.include("ANSI_QUOTES");
    expect(modes).to.not.include("ONLY_FULL_GROUP_BY");
  });

  it("sets a read timeout only when one is configured", () => {
    expect(PinText()).to.not.contain("max_execution_time");
    expect(PinText(1500)).to.match(/, max_execution_time = 1500$/);
  });

  it("names the collation the pin uses", () => {
    expect(PinText()).to.contain(`'${session.binaryCollation}'`);
  });
});

describe("MySQL lock names", () => {
  it("fit the 64-character limit whatever the scope, and differ by scope", () => {
    const long = session.lockName("indexes", "s".repeat(500));
    expect(long).to.match(/^ajs:indexes:[0-9a-f]{40}$/);
    expect(long.length).to.be.at.most(64);
    expect(session.lockName("tables", "a")).to.not.equal(
      session.lockName("tables", "b"),
    );
  });

  it("refuse a purpose that would push the name past the limit", () => {
    expect(() => session.lockName("a".repeat(20), "x")).to.throw(/at most 19/);
    expect(() => session.lockName("Tables", "x")).to.throw(/lowercase/);
  });

  it("are taken and released by literal name", () => {
    expect(Bind(session.acquireLock("ajs:tables:x", 60)).sql).to.equal(
      "SELECT GET_LOCK('ajs:tables:x', 60) AS acquired",
    );
    expect(Bind(session.releaseLock("ajs:tables:x")).sql).to.equal(
      "SELECT RELEASE_LOCK('ajs:tables:x') AS released",
    );
  });
});

describe("MySQL physical types", () => {
  it("maps every kind to its column type", () => {
    const physical = (type: Parameters<typeof syntax.physical>[0]) =>
      Bind(syntax.physical(type)).sql;
    expect(physical(TEXT)).to.equal("LONGTEXT");
    expect(physical(FLOAT)).to.equal("DOUBLE");
    expect(physical(BOOL)).to.equal("TINYINT(1)");
    expect(physical(TIMESTAMP)).to.equal("DATETIME(6)");
    expect(physical(ArrayOf(TEXT))).to.equal("JSON");
    expect(physical(OPAQUE)).to.equal("JSON");
    expect(physical(JsonOf({ a: TEXT }))).to.equal("JSON");
  });

  it("quotes identifiers with backticks", () => {
    expect(Bind(syntax.quote("a`b")).sql).to.equal("`a``b`");
  });
});
