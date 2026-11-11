import { expect } from "chai";
import type { StagedObject } from "@antelopejs/interface-database/common";

import { DIALECTS, type Dialect } from "../../dialect";
import type {
  CompilerSyntax,
  Int32Syntax,
  JsonSyntax,
  RegexSyntax,
  RowSyntax,
  ScalarSyntax,
  TimeSyntax,
} from "../../dialect/sql-types";
import { type Bound, type Sql, join, sql } from "../../statement";
import {
  Compile,
  CrossInstanceRoot,
  LogsRoot,
  Other,
  ProfilesRoot,
  Root,
  Written,
  WrittenStatements,
} from "./pipeline-fixture";

/**
 * What a masked member answers: an inert marker around the fragments it was handed, which are the
 * compiler's own text, and nothing it spelled itself.
 */
function Marked(...parts: Sql[]): Sql {
  return sql`D(${join(parts, sql`, `)})`;
}

function Present(fragment: Sql | undefined): Sql[] {
  return fragment ? [fragment] : [];
}

const MASKED_JSON: JsonSyntax = {
  member: (document) => Marked(document),
  dynamicMember: (document, key) => Marked(document, key),
  is: (value) => Marked(value),
  as: (value) => Marked(value),
  of: (value) => Marked(value),
  parse: (text) => Marked(text),
  text: (value) => Marked(value),
  null: Marked(),
  emptyObject: Marked(),
  emptyArray: Marked(),
  object: (entries) => Marked(...entries.map(([, value]) => value)),
  array: (items) => Marked(...items),
  document: (members, overflow) =>
    Marked(...members.map((member) => member.value), ...Present(overflow)),
  removeKeys: (document) => Marked(document),
  setKeys: (document, entries) =>
    Marked(document, ...entries.map(([, value]) => value)),
  hasKey: (document) => Marked(document),
  includes: (array, element) => Marked(array, element),
  truthy: (value) => Marked(value),
  collect: (element, order) => Marked(element, ...Present(order)),
  length: (container) => Marked(container),
  at: (array, position) => Marked(array, position),
  concatArrays: (left, right) => Marked(left, right),
  shallowMerge: (left, right) => Marked(left, right),
  split: (text) => Marked(text),
  walk: (_kind, source) => ({
    ordinal: Marked(),
    value: Marked(),
    aggregate: (select, where) => Marked(source, select, ...Present(where)),
  }),
};

const MASKED_INT32: Int32Syntax = {
  read: (value) => Marked(value),
  and: (left, right) => Marked(left, right),
  or: (left, right) => Marked(left, right),
  xor: (left, right) => Marked(left, right),
  not: (value) => Marked(value),
  shiftLeft: (value, count) => Marked(value, count),
  shiftRight: (value, count) => Marked(value, count),
  shiftRightUnsigned: (value, count) => Marked(value, count),
};

const MASKED_REGEX: RegexSyntax = {
  translate: (pattern) => pattern,
  matches: (text, pattern) => Marked(text, pattern),
};

const MASKED_SCALAR: ScalarSyntax = {
  cast: (value) => Marked(value),
  bind: {
    text: () => Marked(),
    float: () => Marked(),
    bool: () => Marked(),
    timestamp: () => Marked(),
    json: () => Marked(),
  },
  parseNumber: (text) => Marked(text),
  truncate: (value) => Marked(value),
  concat: (parts) => Marked(...parts),
  left: (text) => Marked(text),
  int32: MASKED_INT32,
  regex: MASKED_REGEX,
};

const MASKED_TIME: TimeSyntax = {
  part: (moment) => Marked(moment),
  inZone: (moment, zone) => Marked(moment, zone),
  isoText: (value) => Marked(value),
  toEpochMs: (value) => Marked(value),
  fromEpochMs: (value) => Marked(value),
  parseText: (text) => Marked(text),
};

const MASKED_ROWS: RowSyntax = {
  nullSafeEqual: (left, right) => Marked(left, right),
  limit: () => Marked(),
  materialize: () => Marked(),
  lookup: (subselect) => ({ join: Marked(subselect), value: Marked() }),
};

const MASKED_SYNTAX: CompilerSyntax = {
  json: MASKED_JSON,
  scalar: MASKED_SCALAR,
  time: MASKED_TIME,
  rows: MASKED_ROWS,
};

/**
 * The MySQL dialect with every expression member masked. Typed against the members' own
 * interfaces, so a member added to the dialect is a compile error here until it is masked too.
 */
const MASKED: Dialect = {
  ...DIALECTS.mysql,
  sql: { ...DIALECTS.mysql.sql, ...MASKED_SYNTAX },
};

/**
 * Engine spellings a compiler file must never write itself: JSON access operators, which MariaDB
 * does not have, `||`, which MySQL reads as OR, and `LATERAL`, which MariaDB does not have.
 */
const FORBIDDEN = ["->", "->>", "||", "LATERAL"];

/** What the MySQL dialect never spells either; its lookup is a lateral, which MariaDB's replaces. */
const MYSQL_FORBIDDEN = FORBIDDEN.filter((token) => token !== "LATERAL");

/** One pipeline of each shape the compiler emits, reads and writes alike. */
const READS: [string, () => StagedObject][] = [
  ["a whole table", () => Root()],
  [
    "a filter on a declared column",
    () => Root().filter((doc) => doc.key("age").gt(30)),
  ],
  [
    "a filter on a path a key column holds",
    () => Root().filter((doc) => doc.key("meta").key("title").eq("Dr")),
  ],
  [
    "a filter on an overflow path",
    () => Root().filter((doc) => doc.key("_internal").key("owner").eq("u1")),
  ],
  [
    "a null test and a negation",
    () =>
      Root().filter((doc) =>
        doc.key("nickname").eq(null).or(doc.key("isActive").not()),
      ),
  ],
  ["an inequality", () => Root().filter((doc) => doc.key("name").ne("Ann"))],
  ["a default", () => Root().map((doc) => doc.key("age").default(0))],
  [
    "an order by an index and a slice",
    () => Root().orderBy("byName", "desc").slice(1, 2),
  ],
  ["an nth", () => Root().orderBy("age").nth(0)],
  ["a get", () => Root().get("a")],
  ["a get across instances", () => CrossInstanceRoot().get("a")],
  [
    "a getAll on a compound index",
    () => Root().getAll([[30, true]], "byAgeActive"),
  ],
  ["a getAll on a list", () => ProfilesRoot().getAll(["ts"], "skills")],
  ["a between on a key column", () => Root().between("byName", "A", "M")],
  ["a pluck", () => Root().pluck("name", "meta")],
  ["a without", () => Root().without("meta")],
  [
    "a map to a document",
    () =>
      Root().map((doc) => ({ id: doc.key("_id"), tags: [doc.key("name"), 1] })),
  ],
  ["a count", () => Root().count()],
  [
    "a union",
    () =>
      Root()
        .map((doc) => doc.key("name"))
        .union(Other().map((doc) => doc.key("name"))),
  ],
  [
    "a subquery",
    () =>
      Root().map((doc) => ({
        products: Other()
          .filter((p) => p.key("name").eq(doc.key("name")))
          .map((p) => p.key("price")),
      })),
  ],
  [
    "an overflow-only table",
    () => LogsRoot().filter((doc) => doc.key("x").ge(1)),
  ],
  [
    "string stages",
    () =>
      Root()
        .filter((doc) =>
          doc
            .key("name")
            .match("^A.b$")
            .and(doc.key("name").concat("!").upcase().strlen().gt(3)),
        )
        .map((doc) => doc.key("name").split(",", 2)),
  ],
  [
    "numeric and bitwise stages",
    () =>
      Root().map((doc) => ({
        sum: doc.key("age").add(1).mul(2).sub(3),
        quotient: doc.key("age").div(2).mod(5).round().ceil().floor(),
        bits: doc.key("age").band(3).bor(4).bxor(5).bnot(),
        shifts: doc.key("age").blshift(2).brshift(1).brshiftPreserveSign(1),
      })),
  ],
  [
    "date stages",
    () =>
      Root()
        .filter((doc) =>
          doc
            .key("joined")
            .year("Europe/Paris")
            .eq(2020)
            .and(doc.key("joined").during(0, 10)),
        )
        .map((doc) => ({
          later: doc.key("joined").add(60),
          elapsed: doc.key("joined").sub(new Date(0)),
          parts: [
            doc.key("joined").dayofweek(),
            doc.key("joined").seconds(),
            doc.key("joined").timeofday(),
            doc.key("joined").epoch(),
          ],
        })),
  ],
  [
    "array stages",
    () =>
      ProfilesRoot().map((doc) => ({
        measures: [doc.key("skills").count(), doc.key("skills").isempty()],
        picks: [
          doc.key("skills").index(-1),
          doc.key("skills").includes("ts"),
          doc.key("skills").slice(1, -1),
        ],
        walked: [
          doc.key("skills").map((skill) => skill.upcase()),
          doc.key("skills").filter((skill) => skill.eq("ts")),
          doc.key("skills").min(),
        ],
        joined: doc.key("skills").add(["x"]),
      })),
  ],
  [
    "object stages",
    () =>
      Root().map((doc) => ({
        merged: doc.key("meta").merge({ owner: "x" }).merge({ title: "y" }),
        keys: doc.key("meta").keys(),
        values: doc.key("meta").values(),
        has: doc.key("meta").hasfields("title", "owner"),
      })),
  ],
  [
    "an inner join",
    () =>
      Root().joinInner(
        Other(),
        (left, right) => left.key("name").eq(right.key("name")),
        (left, right) => ({ person: left, product: right }),
      ),
  ],
  [
    "a left join",
    () =>
      Root().join(
        Other(),
        (left, right) => left.key("name").eq(right.key("name")),
        (left, right) => ({ person: left, product: right }),
      ),
  ],
  ["a lookup of one row", () => Other().lookup(Root(), "name", "name")],
  [
    "a lookup by a nested path",
    () => Other().lookup(Root(), "name", "meta.title"),
  ],
  [
    "a lookup against a plucked stream",
    () => Other().lookup(Root().pluck("name"), "name", "name"),
  ],
  [
    "a lookup of a list",
    () => ProfilesRoot().lookup(Other(), "skills", "name"),
  ],
  [
    "a group with sub-stream aggregates",
    () =>
      Root().group("name", (stream, name) => ({
        name,
        count: stream.count(),
        total: stream.sum("age"),
        mean: stream.map((row) => row.key("age")).avg(),
        first: stream.min("joined"),
        last: stream.max("name"),
        ages: stream.distinct("age"),
      })),
  ],
  [
    "a group on a compound index",
    () => Root().group("byAgeActive", (stream, group) => ({ group })),
  ],
  ["a sum", () => Root().sum("age")],
  ["an average", () => Root().avg("age")],
  ["a minimum", () => Root().min("isActive")],
  ["a maximum", () => Root().max("rev")],
  ["a distinct", () => Root().orderBy("age").distinct("name")],
  [
    "a slice bounded by another query's count",
    () => Root().orderBy("age").slice(1, Other().count()),
  ],
];

const WRITES: [string, () => StagedObject][] = [
  [
    "an insert",
    () =>
      Root().insert([
        { name: "Ann", meta: { title: "Dr" } },
        { _id: "b", nickname: "B" },
      ]),
  ],
  [
    "an upsert that merges",
    () =>
      Root().insert([{ _id: "a", age: 3, nickname: "A" }, { _id: "b" }], {
        conflict: "update",
      }),
  ],
  [
    "an upsert that replaces",
    () => Root().insert([{ _id: "a", name: "A" }], { conflict: "replace" }),
  ],
  [
    "an update",
    () =>
      Root()
        .get("a")
        .update({ age: 4, nickname: undefined, meta: { title: "Mx" } }),
  ],
  [
    "an update by a mapper",
    () =>
      Root().update((doc) => ({
        age: doc.key("age"),
        nickname: doc.key("name"),
      })),
  ],
  ["a replace", () => Root().get("a").replace({ name: "A" })],
  ["a delete", () => Root().orderBy("age").slice(0, 1).delete()],
  [
    "an atomic update",
    () =>
      Root().atomicMutation("a", {
        type: "update",
        patch: { age: 1 },
        revisionField: "rev",
        expectedRevision: { kind: "missing" },
        nextRevision: "r1",
      }),
  ],
  [
    "an atomic delete",
    () =>
      Root().atomicMutation("a", {
        type: "deleteIfEqual",
        field: "name",
        expectedValue: "A",
      }),
  ],
];

function CompiledCorpus(dialect: Dialect): [string, Bound][] {
  const reads = READS.map(([name, query]): [string, Bound] => [
    name,
    Compile(query(), dialect),
  ]);
  const writes = WRITES.flatMap(([name, query]) =>
    WrittenStatements(Written(query(), dialect), ["a"]).map(
      (statement): [string, Bound] => [name, statement],
    ),
  );
  return [...reads, ...writes];
}

describe("The dialect seam", () => {
  it("leaves no engine-only spelling in the text the compiler writes itself", () => {
    for (const [name, statement] of CompiledCorpus(MASKED)) {
      for (const token of FORBIDDEN) {
        expect(
          statement.sql,
          `${name} spells '${token}' outside the dialect`,
        ).to.not.include(token);
      }
    }
  });

  it("masks every function the dialect spells, so the check reads the compiler's text alone", () => {
    const masked = CompiledCorpus(MASKED)
      .map(([, statement]) => statement.sql)
      .join("\n");
    const real = CompiledCorpus(DIALECTS.mysql)
      .map(([, statement]) => statement.sql)
      .join("\n");
    expect(real).to.match(/JSON_EXTRACT|JSON_MERGE_PRESERVE|CAST\(/);
    expect(real).to.include("LEFT JOIN LATERAL (");
    expect(masked).to.not.match(/JSON_|CAST\(|DATE_FORMAT|NO_MERGE|<=>|LIMIT/);
  });

  it("masks the members the value stages read, so each engine spelling comes from the dialect alone", () => {
    const masked = CompiledCorpus(MASKED)
      .map(([, statement]) => statement.sql)
      .join("\n");
    const real = CompiledCorpus(DIALECTS.mysql)
      .map(([, statement]) => statement.sql)
      .join("\n");
    const SPELLINGS = [
      "REGEXP_LIKE",
      "CONCAT(",
      "JSON_TABLE",
      "JSON_OBJECTAGG",
      "SUBSTRING_INDEX",
      "TIMESTAMPADD",
      "CONVERT_TZ",
      "MEMBER OF",
      "MOD(MOD(",
      " & ",
      " ^ ",
      "~(",
      " << ",
      " >> ",
    ];
    for (const spelling of SPELLINGS) {
      expect(real, `the real dialect spells ${spelling}`).to.include(spelling);
      expect(masked, `a compiler file spells ${spelling}`).to.not.include(
        spelling,
      );
    }
  });

  it("compiles every pipeline of the corpus with the MySQL dialect too", () => {
    for (const [name, statement] of CompiledCorpus(DIALECTS.mysql)) {
      for (const token of MYSQL_FORBIDDEN) {
        expect(statement.sql, `${name} spells '${token}'`).to.not.include(
          token,
        );
      }
    }
  });
});
