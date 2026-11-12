import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "nested_group_order";
const INSTANCE = "one";

interface Item {
  _id: string;
  kind: string;
}

interface Owner {
  _id: string;
}

const schema = new Schema<{ items: Item; owners: Owner }>(SCHEMA_ID, {
  items: { fields: { kind: "string" }, indexes: {} },
  owners: { fields: {}, indexes: {} },
});

function Items() {
  return schema.instance(INSTANCE).table("items");
}

function Owners() {
  return schema.instance(INSTANCE).table("owners");
}

/** Kind `b` holds the most items and `a` the fewest, so neither its key nor its count is id order. */
const ITEMS: Item[] = [
  { _id: "i1", kind: "b" },
  { _id: "i2", kind: "c" },
  { _id: "i3", kind: "a" },
  { _id: "i4", kind: "b" },
  { _id: "i5", kind: "c" },
  { _id: "i6", kind: "b" },
];

function KindGroups() {
  return Items().group("kind", (stream, kind) => ({
    kind,
    count: stream.count(),
  }));
}

/** Fails where a stage that wraps the ordered groups in a derived table leaves their order inside it. */
async function MapAfterOrder(): Promise<void> {
  const [owner] = await Owners()
    .map(() => ({
      kinds: KindGroups()
        .orderBy("kind", "desc")
        .map((group) => group.key("kind")),
    }))
    .run();
  expect(owner.kinds).to.deep.equal(["c", "b", "a"]);
}

async function FilterAfterOrder(): Promise<void> {
  const [owner] = await Owners()
    .map(() => ({
      kinds: KindGroups()
        .orderBy("count")
        .filter((group) => group.key("count").gt(1))
        .map((group) => group.key("kind")),
    }))
    .run();
  expect(owner.kinds).to.deep.equal(["c", "b"]);
}

describe("a nested group's order", function () {
  this.timeout(60_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Items().insert(ITEMS).run();
    await Owners()
      .insert([{ _id: "o1" }])
      .run();
  });

  it("keeps the groups in order through a later map", MapAfterOrder);
  it("keeps the groups in order through a later filter", FilterAfterOrder);
});
