import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "group_distinct";
const INSTANCE = "one";

interface Item {
  _id: string;
  kind: string;
  note?: string | null;
}

const schema = new Schema<{ items: Item }>(SCHEMA_ID, {
  items: { fields: { kind: "string" }, indexes: {} },
});

function Items() {
  return schema.instance(INSTANCE).table("items");
}

/**
 * Kind `a` holds an undeclared `note` that is a JSON null, one that is absent twice, and the string
 * `x` twice. Kind `b` holds only absent notes, kind `c` only JSON nulls.
 */
const ITEM_ROWS: Item[] = [
  { _id: "a1", kind: "a", note: null },
  { _id: "a2", kind: "a" },
  { _id: "a3", kind: "a" },
  { _id: "a4", kind: "a", note: "x" },
  { _id: "a5", kind: "a", note: "x" },
  { _id: "b1", kind: "b" },
  { _id: "b2", kind: "b" },
  { _id: "c1", kind: "c", note: null },
  { _id: "c2", kind: "c", note: null },
];

const KINDS = ["a", "b", "c"];

type Note = Item["note"];

/** Orders notes by their text, `null` as `"null"`, which a result is sorted by to compare. */
function ByText(left: Note, right: Note): number {
  return String(left).localeCompare(String(right));
}

async function TopLevelNotes(kind: string): Promise<Note[]> {
  const notes = await Items()
    .filter((item) => item.key("kind").eq(kind))
    .distinct("note")
    .run();
  return [...notes].sort(ByText);
}

/** A group's dedup keeps an absent `note` and a JSON null apart, as a dedup at the top does. */
async function GroupDistinctKeepsAbsentApartFromNull(): Promise<void> {
  const read = await Items()
    .group("kind", (stream, kind) => ({ kind, notes: stream.distinct("note") }))
    .run();
  const grouped = read
    .map((row) => ({ kind: row.kind, notes: [...row.notes].sort(ByText) }))
    .sort((left, right) => ByText(left.kind, right.kind));
  const top = await Promise.all(
    KINDS.map(async (kind) => ({ kind, notes: await TopLevelNotes(kind) })),
  );
  expect(top).to.deep.equal([
    { kind: "a", notes: [null, null, "x"] },
    { kind: "b", notes: [null] },
    { kind: "c", notes: [null] },
  ]);
  expect(grouped).to.deep.equal(top);
}

describe("a dedup inside a group", function () {
  this.timeout(30_000);

  before(async () => {
    await schema.createInstance(INSTANCE).run();
    await Items().insert(ITEM_ROWS).run();
  });

  after(async () => {
    await schema.destroyInstance(INSTANCE).run();
  });

  it(
    "keeps an absent field apart from a JSON null, as a dedup at the top does",
    GroupDistinctKeepsAbsentApartFromNull,
  );
});
