import { expect } from "chai";
import { ValueProxy } from "@antelopejs/interface-database";

import {
  Compile,
  CompiledRelation,
  CrossInstanceRoot,
  Other,
  PlanOf,
  ProfilesRoot,
  Root,
} from "./pipeline-fixture";

const ROW_COLUMNS =
  "`t0`.`_id`, `t0`.`_instance`, `t0`.`name`, `t0`.`age`, `t0`.`isActive`, `t0`.`joined`, `t0`.`meta`, `t0`.`_extra`";
const FROM_PEOPLE = "FROM `directory__people` AS `t0`";
const DEFAULT_INSTANCE = "(`t0`.`_instance` = ?)";

/** The key column `byName` declares over the `name` column, by the name the plan gave it. */
function NameKey(): string {
  const key = PlanOf("people").keyColumns.find(
    (column) => column.source === "name",
  );
  return `\`t0\`.\`${key?.name ?? "missing"}\``;
}

describe("A read", () => {
  it("selects the stored columns of the default instance, binding its empty id", () => {
    expect(Compile(Root())).to.deep.equal({
      sql: `SELECT ${ROW_COLUMNS} ${FROM_PEOPLE} WHERE ${DEFAULT_INSTANCE}`,
      args: [""],
    });
  });

  it("drops the instance predicate across instances and bounds a get to the first instance", () => {
    expect(Compile(CrossInstanceRoot().get("a"))).to.deep.equal({
      sql: `SELECT ${ROW_COLUMNS} ${FROM_PEOPLE} WHERE (\`t0\`.\`_id\` = ?) ORDER BY \`t0\`.\`_instance\` ASC LIMIT ?`,
      args: ["a", 1],
    });
  });

  it("compares a declared number with a bound double, so an integer argument is not a BIGINT", () => {
    const bound = Compile(Root().filter((doc) => doc.key("age").gt(30)));
    expect(bound.sql).to.equal(
      `SELECT ${ROW_COLUMNS} ${FROM_PEOPLE} WHERE ${DEFAULT_INSTANCE} AND ((\`t0\`.\`age\` > CAST(? AS DOUBLE)))`,
    );
    expect(bound.args).to.deep.equal(["", 30]);
  });

  it("narrows by a prefix key column and rechecks the value itself", () => {
    const bound = Compile(Root().filter((doc) => doc.key("name").eq("Ann")));
    expect(bound.sql).to.equal(
      `SELECT ${ROW_COLUMNS} ${FROM_PEOPLE} WHERE ${DEFAULT_INSTANCE} AND ((${NameKey()} = LEFT(?, 640) AND \`t0\`.\`name\` = ?))`,
    );
    expect(bound.args).to.deep.equal(["", "Ann", "Ann"]);
  });

  it("bounds a prefix key inclusively for a strict comparison, so a tie on the prefix is kept", () => {
    const bound = Compile(Root().filter((doc) => doc.key("name").gt("Ann")));
    expect(bound.sql).to.include(
      `${NameKey()} >= LEFT(?, 640) AND \`t0\`.\`name\` > ?`,
    );
  });

  it("names the key column a path below a declared object reads into, read as a string", () => {
    const bound = Compile(
      Root().filter((doc) => doc.key("meta").key("title").eq("Dr")),
    );
    expect(bound.sql).to.match(
      /`t0`\.`__k_meta_title_[0-9a-f]{8}` = \? AND \(CASE WHEN/,
    );
    expect(bound.sql).to.include("JSON_EXTRACT(`t0`.`meta`, '$.\"title\"')");
  });

  it("names the key column of an overflow path", () => {
    const bound = Compile(
      Root().filter((doc) => doc.key("_internal").key("owner").eq("u1")),
    );
    expect(bound.sql).to.match(
      /`t0`\.`__k__internal_owner_[0-9a-f]{8}` = LEFT\(\?, 640\)/,
    );
  });

  it("reads a field it cannot key in full, after a subselect that left the key columns out", () => {
    const bound = Compile(
      Root()
        .slice(0, 5)
        .filter((doc) => doc.key("name").eq("Ann")),
    );
    expect(bound.sql).to.not.include("__k_");
    expect(bound.sql).to.include("(`t1`.`name` = ?)");
  });

  it("tests a null against both SQL NULL and a JSON null where the operand is JSON", () => {
    const bound = Compile(Root().filter((doc) => doc.key("nickname").eq(null)));
    expect(bound.sql).to.include(
      "((JSON_EXTRACT(`t0`.`_extra`, '$.\"nickname\"') IS NULL) OR (JSON_EXTRACT(`t0`.`_extra`, '$.\"nickname\"') = CAST('null' AS JSON)))",
    );
  });

  it("keeps a row whose operand is absent out of neither side of an inequality", () => {
    const bound = Compile(Root().filter((doc) => doc.key("age").ne(3)));
    expect(bound.sql).to.include("(NOT (`t0`.`age` <=> CAST(? AS DOUBLE)))");
  });

  it("negates a condition with IS NOT TRUE, which keeps a row whose operand is NULL", () => {
    const bound = Compile(Root().filter((doc) => doc.key("isActive").not()));
    expect(bound.sql).to.include("((`t0`.`isActive` IS NOT TRUE))");
  });
});

describe("A read's order and bounds", () => {
  it("orders by an index's key column and binds the row bounds", () => {
    expect(Compile(Root().orderBy("byName", "desc").slice(1, 2))).to.deep.equal(
      {
        sql: `SELECT ${ROW_COLUMNS} ${FROM_PEOPLE} WHERE ${DEFAULT_INSTANCE} ORDER BY ${NameKey()} DESC LIMIT ? OFFSET ?`,
        args: ["", 2, 1],
      },
    );
  });

  it("orders by a field that is no index by the field itself", () => {
    expect(Compile(Root().orderBy("age")).sql).to.include(
      "ORDER BY `t0`.`age` ASC",
    );
  });

  it("spells an offset with no count through the largest limit the server takes", () => {
    const bound = Compile(Root().slice(3));
    expect(bound.sql).to.match(/LIMIT 18446744073709551615 OFFSET \?$/);
    expect(bound.args).to.deep.equal(["", 3]);
  });

  it("clamps a negative bound to zero and truncates a fraction", () => {
    expect(Compile(Root().slice(-2, 2.7)).args).to.deep.equal(["", 2, 0]);
  });

  it("refuses a row bound computed by the statement, naming the stage", () => {
    expect(() => Compile(Root().slice(ValueProxy.constant(1)))).to.throw(
      /'slice' takes a constant number/,
    );
  });

  it("answers nth as one row", () => {
    const relation = CompiledRelation(Root().orderBy("age").nth(2));
    expect(relation.single).to.equal(true);
    expect(relation.limit).to.equal(1);
    expect(relation.offset).to.equal(2);
  });

  it("answers get as undefined when it reads no row, which is what tells it from a null", () => {
    expect(CompiledRelation(Root().get("a")).absent).to.equal(undefined);
    expect(CompiledRelation(Root().orderBy("age").nth(0)).absent).to.equal(
      null,
    );
  });
});

describe("A selection by key", () => {
  it("matches a compound index row-wise", () => {
    expect(Compile(Root().getAll([[30, true]], "byAgeActive")).sql).to.include(
      "((`t0`.`age`, `t0`.`isActive`) IN ((CAST(? AS DOUBLE), (? <> 0))))",
    );
  });

  it("matches a list column by membership, one test per key", () => {
    const bound = Compile(ProfilesRoot().getAll(["ts", "go"], "skills"));
    expect(bound.sql).to.include(
      "((? MEMBER OF (`t0`.`skills`)) OR (? MEMBER OF (`t0`.`skills`)))",
    );
    expect(bound.args).to.deep.equal(["", "ts", "go"]);
  });

  it("matches nothing for an empty key list", () => {
    expect(Compile(Root().getAll([])).sql).to.include("AND (FALSE)");
  });

  it("ranges over a key column half-open, rechecking both bounds on the value", () => {
    const bound = Compile(Root().between("byName", "A", "M"));
    expect(bound.sql).to.include(
      `(${NameKey()} >= LEFT(?, 640) AND \`t0\`.\`name\` >= ?) AND (${NameKey()} <= LEFT(?, 640) AND \`t0\`.\`name\` < ?)`,
    );
    expect(bound.args).to.deep.equal(["", "A", "A", "M", "M"]);
  });
});

describe("A reshaping stage", () => {
  it("counts rows as a double, since the server's count reaches the driver as text", () => {
    expect(Compile(Root().count()).sql).to.equal(
      `SELECT CAST(COUNT(*) AS DOUBLE) AS \`value\` ${FROM_PEOPLE} WHERE ${DEFAULT_INSTANCE}`,
    );
  });

  it("builds a plucked document without nulls, keeping a declared object whole", () => {
    expect(Compile(Root().pluck("name", "meta")).sql).to.include(
      "JSON_MERGE_PRESERVE(JSON_MERGE_PATCH(JSON_OBJECT(), JSON_OBJECT('name', CAST(JSON_QUOTE(`t0`.`name`) AS JSON))), IF(`t0`.`meta` IS NULL, JSON_OBJECT(), JSON_OBJECT('meta', `t0`.`meta`))) AS `value`",
    );
  });

  it("concatenates two streams as one value-mode relation of both sides' rows", () => {
    const bound = Compile(
      Root()
        .map((doc) => doc.key("name"))
        .union(Other().map((doc) => doc.key("name"))),
    );
    expect(bound.sql).to.match(
      /^SELECT `t2`\.`value` AS `value` FROM \(\(SELECT .* FROM `directory__people` AS `t0` .*\) UNION ALL \(SELECT .* FROM `directory__products` AS `t1` .*\)\) AS `t2`$/,
    );
  });

  it("collects a nested stream into a JSON array, empty rather than NULL", () => {
    const bound = Compile(
      Root().map((doc) => ({
        products: Other()
          .filter((p) => p.key("name").eq(doc.key("name")))
          .map((p) => p.key("price")),
      })),
    );
    expect(bound.sql).to.include(
      "COALESCE(CAST(CONCAT('[', GROUP_CONCAT(COALESCE(CAST(",
    );
    expect(bound.sql).to.include("JSON_ARRAY())");
  });

  it("names a stage whose family is not implemented yet rather than calling it unknown", () => {
    expect(() => Compile(Root().sum("age"))).to.throw(
      /'sum' stage \(aggregate family\) is not implemented/,
    );
    expect(() =>
      Compile(Root().filter((doc) => doc.key("age").add(1).gt(2))),
    ).to.throw(/'add' expression stage \(numeric family\) is not implemented/);
  });
});
