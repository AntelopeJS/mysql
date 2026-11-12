import { expect } from "chai";

import { Bind, ident } from "../../statement";
import { DIALECTS } from "../../dialect";
import { Compile, Root } from "./pipeline-fixture";
import { Occurrences } from "./expression-fixture";

const NESTED_READ = "JSON_EXTRACT(JSON_EXTRACT(";

describe("a read of a value nested below a document", () => {
  it("reads a path below the overflow column in one step, however deep", () => {
    const { sql } = Compile(
      Root().filter((doc) =>
        doc.key("_internal").key("data").key("title").key("fr").eq("x"),
      ),
    );
    expect(sql).to.include(
      'JSON_EXTRACT(`t0`.`_extra`, \'$."_internal"."data"."title"."fr"\')',
    );
    expect(Occurrences(sql, NESTED_READ)).to.equal(0);
  });

  it("reads a path below a declared object in one step", () => {
    const { sql } = Compile(
      Root().filter((doc) => doc.key("meta").key("names").key("fr").eq("x")),
    );
    expect(sql).to.include('JSON_EXTRACT(`t0`.`meta`, \'$."names"."fr"\')');
    expect(Occurrences(sql, NESTED_READ)).to.equal(0);
  });

  it("reads a path below a projected document in one step", () => {
    const { sql } = Compile(
      Root()
        .map((doc) => ({ owner: doc.key("_internal") }))
        .filter((doc) =>
          doc.key("owner").key("data").key("title").key("fr").eq("x"),
        ),
    );
    expect(sql).to.include('\'$."owner"."data"."title"."fr"\'');
    expect(Occurrences(sql, NESTED_READ)).to.equal(0);
  });

  it("quotes each key of the path apart, so a key holding a dot or a quote stays one key", () => {
    const member = DIALECTS.mysql.sql.json.member(ident("d"), "a.b", 'q"');
    expect(Bind(member).sql).to.equal(
      'JSON_EXTRACT(`d`, \'$."a.b"."q\\\\""\')',
    );
  });
});
