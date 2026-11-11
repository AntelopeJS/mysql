import { expect } from "chai";

import {
  Compile,
  CompiledRelation,
  Other,
  ProfilesRoot,
  Root,
} from "./pipeline-fixture";

const PRODUCTS_SUBSELECT =
  "(SELECT `t1`.`_id`, `t1`.`_instance`, `t1`.`name`, `t1`.`price`, `t1`.`_extra` FROM `directory__products` AS `t1` WHERE (`t1`.`_instance` = ?)) AS `t2`";

function InnerJoined() {
  return Root().joinInner(
    Other(),
    (left, right) => left.key("name").eq(right.key("name")),
    (left, right) => ({ person: left, product: right }),
  );
}

function LeftJoined() {
  return Root().join(
    Other(),
    (left, right) => left.key("name").eq(right.key("name")),
    (left, right) => ({ person: left, product: right }),
  );
}

describe("the join stages", () => {
  it("joins the other query, compiled from its own root, on the condition", () => {
    const sql = Compile(InnerJoined()).sql;
    expect(sql).to.include(
      ` FROM \`directory__people\` AS \`t0\` JOIN ${PRODUCTS_SUBSELECT} ON ((\`t0\`.\`__k_name_`,
    );
    expect(sql).to.include("AND `t0`.`name` = `t2`.`name`))");
  });

  it("keeps every left row through a left join, reading a missed right row as null", () => {
    const sql = Compile(LeftJoined()).sql;
    expect(sql).to.include(` LEFT JOIN ${PRODUCTS_SUBSELECT} ON `);
    expect(sql).to.include(
      "'product', (CASE WHEN `t2`.`_id` IS NOT NULL THEN JSON_MERGE_PRESERVE(",
    );
  });

  it("reads a right row of an inner join as itself, since it is always there", () => {
    expect(Compile(InnerJoined()).sql).to.not.include("IS NOT NULL THEN");
  });

  it("yields the mapper's value and forgets the table, so a write after it has no target", () => {
    const relation = CompiledRelation(InnerJoined());
    expect(relation.origin).to.equal(undefined);
    expect(relation.projection?.type.kind).to.equal("json");
  });
});

describe("the lookup stage", () => {
  it("replaces the local key with one row of the other query, through a lateral bounded to one row", () => {
    const bound = Compile(Other().lookup(Root(), "name", "name"));
    expect(bound.sql).to.match(
      /^SELECT JSON_SET\(.*, '\$\."name"', `t2`\.`value`\) AS `value` FROM `directory__products` AS `t0` LEFT JOIN LATERAL \(SELECT .* FROM `directory__people` AS `t1` WHERE .* LIMIT \?\) AS `t2` ON TRUE WHERE \(`t0`\.`_instance` = \?\)$/,
    );
    expect(bound.args).to.deep.equal(["", "", "", 1, ""]);
  });

  it("correlates through the other table's key column, so its index serves each row", () => {
    expect(Compile(Other().lookup(Root(), "name", "name")).sql).to.match(
      /WHERE \(`t1`\.`_instance` = \?\) AND \(`t1`\.`__k_name_[0-9a-f]{8}` = LEFT\(`t0`\.`name`, 640\) AND `t1`\.`name` = `t0`\.`name`\)/,
    );
  });

  it("reads a dotted other key as a path, reaching the key column its index holds", () => {
    expect(Compile(Other().lookup(Root(), "name", "meta.title")).sql).to.match(
      /`t1`\.`__k_meta_title_[0-9a-f]{8}` = `t0`\.`name` AND \(CASE WHEN/,
    );
  });

  it("pushes the correlation below a pluck, onto the table's own key column", () => {
    expect(
      Compile(Other().lookup(Root().pluck("name", "age"), "name", "name")).sql,
    ).to.match(
      /FROM `directory__people` AS `t1` WHERE \(`t1`\.`_instance` = \?\) AND \(`t1`\.`__k_name_[0-9a-f]{8}` = LEFT\(`t0`\.`name`, 640\)/,
    );
  });

  it("collects every match for a list key into an array, empty rather than null", () => {
    const query = ProfilesRoot().lookup(Other(), "skills", "name");
    const sql = Compile(query).sql;
    expect(sql).to.include(
      "LEFT JOIN LATERAL (SELECT COALESCE(CAST(CONCAT('[', GROUP_CONCAT(",
    );
    expect(sql).to.include(
      "(CAST(JSON_QUOTE(`t1`.`name`) AS JSON) MEMBER OF (`t0`.`skills`))",
    );
    expect(sql).to.not.include("LIMIT");
    const type = CompiledRelation(query).projection?.type;
    expect(type?.kind === "json" && type.keys?.skills).to.deep.equal({
      kind: "array",
      elem: {
        kind: "json",
        keys: {
          _id: { kind: "text" },
          _instance: { kind: "text" },
          name: { kind: "text" },
          price: { kind: "float" },
        },
      },
    });
  });

  it("keeps a lookup on one row a single row", () => {
    const relation = CompiledRelation(
      Other().get("a").lookup(Root(), "name", "name"),
    );
    expect(relation.single).to.equal(true);
  });

  it("refuses a local key with no declared type, rather than guess whether it holds a list", () => {
    expect(() => Compile(Root().lookup(Other(), "rev", "name"))).to.throw(
      "The 'lookup' stage takes its form from the local key's declared type, and 'rev' has none",
    );
  });
});
