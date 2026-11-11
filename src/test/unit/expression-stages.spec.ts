import { expect } from "chai";
import { ValueProxy } from "@antelopejs/interface-database";

import { sql } from "../../statement";
import { OPAQUE } from "../../implementations/database/types";
import type { StageMap } from "../../implementations/database/stage";
import { DATE_STAGES } from "../../implementations/database/stages-date";
import { ARRAY_STAGES } from "../../implementations/database/stages-array";
import { OBJECT_STAGES } from "../../implementations/database/stages-object";
import { STRING_STAGES } from "../../implementations/database/stages-string";
import { NUMERIC_STAGES } from "../../implementations/database/stages-numeric";
import { LastStage } from "./expression-fixture";
import { NewContext } from "./pipeline-fixture";

const PENDING_ZONE = "America/New_York";

const HANDLERS: StageMap = {
  ...NUMERIC_STAGES,
  ...ARRAY_STAGES,
  ...OBJECT_STAGES,
  ...STRING_STAGES,
  ...DATE_STAGES,
};

const TEXT = ValueProxy.constant("a");
const NUMBER = ValueProxy.constant(1);
const INSTANT = ValueProxy.constant(new Date(0));
const LIST = ValueProxy.constant([1]);
const DOCUMENT = ValueProxy.constant({ a: 1 });

const RECORDED = [
  TEXT.upcase(),
  TEXT.downcase(),
  TEXT.strlen(),
  TEXT.concat("x"),
  TEXT.match("x"),
  TEXT.split(",", 1),
  NUMBER.add(1),
  NUMBER.sub(1),
  NUMBER.mul(1),
  NUMBER.div(1),
  NUMBER.mod(1),
  NUMBER.round(),
  NUMBER.ceil(),
  NUMBER.floor(),
  NUMBER.band(1),
  NUMBER.bor(1),
  NUMBER.bxor(1),
  NUMBER.bnot(),
  NUMBER.blshift(1),
  NUMBER.brshift(1),
  INSTANT.epoch(),
  INSTANT.during(0, 1),
  LIST.index(0),
  LIST.includes(1),
  LIST.slice(0),
  LIST.map((value) => value),
  LIST.filter((value) => value),
  LIST.count(),
  LIST.isempty(),
  LIST.sum(),
  LIST.avg(),
  LIST.min(),
  LIST.max(),
  DOCUMENT.merge({ b: 2 }),
  DOCUMENT.keys(),
  DOCUMENT.values(),
  DOCUMENT.hasfields("a"),
].map(LastStage);

describe("The value stage families", () => {
  it("handle every stage the interface records for text, numbers, instants, lists and documents", () => {
    for (const stage of RECORDED) {
      expect(Object.keys(HANDLERS), stage.stage).to.include(stage.stage);
    }
  });

  it("drop a pending zone in every stage but the date parts that read it", () => {
    for (const stage of RECORDED) {
      const out = HANDLERS[stage.stage](
        { current: { sql: sql`x`, type: OPAQUE }, timezone: PENDING_ZONE },
        stage,
        NewContext(),
      );
      expect(out.timezone, stage.stage).to.equal(undefined);
    }
  });

  it("record a zone without transforming the value, and let the part that follows read it", () => {
    const [zone, part] = INSTANT.hours(PENDING_ZONE).build().slice(-2);
    const current = { sql: sql`x`, type: OPAQUE };
    const recorded = HANDLERS[zone.stage]({ current }, zone, NewContext());
    expect(recorded).to.deep.equal({ current, timezone: PENDING_ZONE });
    const read = HANDLERS[part.stage](recorded, part, NewContext());
    expect(read.timezone).to.equal(undefined);
  });
});
