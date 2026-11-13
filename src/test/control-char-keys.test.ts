import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

import { WaitForIndexes } from "../implementations/database/schema";

const SCHEMA_ID = "control_char_keys";
const INSTANCE = "one";

/** Keys JSON writes with an escape: a newline, a tab and a control byte JSON spells in hex. */
const KEYS = ["a\nb", "tab\there", "bell\u0007"] as const;

type Row = { _id: string } & Partial<Record<string, string>>;

const schema = new Schema<{ bare: Row; keyed: Row }>(SCHEMA_ID, {
  bare: { fields: {}, indexes: {} },
  keyed: {
    fields: {},
    indexes: Object.fromEntries(
      KEYS.map((key, at) => [`k${at}`, { fields: [key] }]),
    ),
  },
});

const ROWS: Row[] = ["x", "y", "z"].map((id, at) => ({
  _id: id,
  ...Object.fromEntries(KEYS.map((key) => [key, `${key} ${String(2 - at)}`])),
}));

type TableId = "bare" | "keyed";

function Table(table: TableId) {
  return schema.instance(INSTANCE).table(table);
}

describe("a key holding a control character", function () {
  this.timeout(120_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Table("bare").insert(ROWS).run();
    await Table("keyed").insert(ROWS).run();
    await WaitForIndexes(SCHEMA_ID);
  });

  for (const key of KEYS) {
    const label = JSON.stringify(key);

    it(`reads ${label} back`, async () => {
      const values = await Table("bare")
        .orderBy("_id")
        .map((row) => row.key(key))
        .run();
      expect(values).to.deep.equal(ROWS.map((row) => row[key]));
    });

    it(`filters on ${label}`, async () => {
      const rows = await Table("bare")
        .filter((row) => row.key(key).eq(`${key} 1`))
        .run();
      expect(rows.map((row) => row._id)).to.deep.equal(["y"]);
    });

    it(`sorts by ${label}`, async () => {
      const rows = await Table("bare").orderBy(key).run();
      expect(rows.map((row) => row._id)).to.deep.equal(["z", "y", "x"]);
    });

    it(`finds rows by an index over ${label}`, async () => {
      const index = `k${KEYS.indexOf(key)}`;
      const rows = await Table("keyed").getAll(`${key} 0`, index).run();
      expect(rows.map((row) => row._id)).to.deep.equal(["z"]);
    });

    it(`sets and removes ${label}`, async () => {
      await Table("bare")
        .get("x")
        .update({ [key]: "set" })
        .run();
      expect((await Table("bare").get("x").run())?.[key]).to.equal("set");
      const { [key]: _removed, ...kept } = ROWS[0];
      await Table("bare").get("x").replace(kept).run();
      expect(await Table("bare").get("x").run()).to.not.have.property(key);
      await Table("bare")
        .get("x")
        .update({ [key]: ROWS[0][key] })
        .run();
    });
  }
});
