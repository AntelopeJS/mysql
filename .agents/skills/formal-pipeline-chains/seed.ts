import "@antelopejs/interface-database/query";
import { Schema } from "@antelopejs/interface-database/schema";
import type { Table } from "@antelopejs/interface-database/selection";

import type { Doc, Tables } from "./model";

export interface Item {
  _id: string;
  n: number;
  slug: string;
  kind?: string;
  ownerId?: string;
  refs?: string[];
}

export interface Owner {
  _id: string;
  take: number;
  label: string;
}

const ITEM_FIELDS = {
  n: "number",
  kind: "string",
  slug: "string",
  ownerId: "string",
  refs: "string[]",
} as const;

/** The three tables of a fixture, read on the default instance of its schema. */
export interface Handles {
  readonly items: () => Table<Item>;
  readonly extras: () => Table<Item>;
  readonly owners: () => Table<Owner>;
}

/**
 * Ten items. Each `n` from 0 to 3 is held by several, each of three kinds by some, two have no
 * kind, one names an owner that does not exist and one names none, each holds a list of owners (some missing), so a chain meets every answer
 * of a comparison, a group and a lookup. `slug` is unique across `items` and `extras`.
 */
export const ITEMS: readonly Item[] = [
  {
    _id: "i00",
    n: 0,
    kind: "a",
    slug: "s00",
    ownerId: "o1",
    refs: ["o2", "o1"],
  },
  { _id: "i01", n: 1, kind: "b", slug: "s01", ownerId: "o2", refs: [] },
  {
    _id: "i02",
    n: 1,
    slug: "s02",
    ownerId: "missing",
    refs: ["o4", "missing"],
  },
  { _id: "i03", n: 2, kind: "a", slug: "s03", refs: ["o5"] },
  {
    _id: "i04",
    n: 2,
    kind: "c",
    slug: "s04",
    ownerId: "o3",
    refs: ["o1", "o3", "o4"],
  },
  { _id: "i05", n: 3, kind: "b", slug: "s05", ownerId: "o1", refs: [] },
  { _id: "i06", n: 0, kind: "c", slug: "s06", ownerId: "o2", refs: ["o3"] },
  { _id: "i07", n: 3, kind: "a", slug: "s07", ownerId: "o4", refs: ["o1"] },
  {
    _id: "i08",
    n: 1,
    kind: "a",
    slug: "s08",
    ownerId: "o3",
    refs: ["o2", "o5", "o1"],
  },
  { _id: "i09", n: 2, slug: "s09", ownerId: "o1", refs: ["missing"] },
];

/** Rows a `union` adds: ids and slugs of their own, the same fields. */
export const EXTRAS: readonly Item[] = [
  { _id: "x00", n: 1, kind: "a", slug: "s10", ownerId: "o1", refs: ["o1"] },
  { _id: "x01", n: 3, kind: "c", slug: "s11", refs: [] },
  { _id: "x02", n: 0, slug: "s12", ownerId: "o2", refs: ["o2", "o4"] },
];

/** `o5` takes a count no item has, so every query of it reads no row. */
export const OWNERS: readonly Owner[] = [
  { _id: "o1", take: 1, label: "L1" },
  { _id: "o2", take: 2, label: "L2" },
  { _id: "o3", take: 0, label: "L0" },
  { _id: "o4", take: 3, label: "L3" },
  { _id: "o5", take: 9, label: "L9" },
];

function Plain(rows: readonly (Item | Owner)[]): Doc[] {
  return rows.map((row) => ({ ...row }));
}

export const TABLES: Tables = {
  items: Plain(ITEMS),
  extras: Plain(EXTRAS),
  owners: Plain(OWNERS),
};

/** A schema of its own with the three tables, so two suites never read each other's rows. */
export function Fixture(schemaId: string) {
  const schema = new Schema<{ items: Item; extras: Item; owners: Owner }>(
    schemaId,
    {
      items: { fields: ITEM_FIELDS, indexes: {} },
      extras: { fields: ITEM_FIELDS, indexes: {} },
      owners: { fields: { take: "number", label: "string" }, indexes: {} },
    },
  );
  const handles: Handles = {
    items: () => schema.instance().table("items"),
    extras: () => schema.instance().table("extras"),
    owners: () => schema.instance().table("owners"),
  };
  return {
    handles,
    async seed(items: readonly Item[]): Promise<void> {
      await schema.createInstance().run();
      if (items.length > 0) {
        await handles
          .items()
          .insert([...items])
          .run();
      }
      await handles
        .extras()
        .insert([...EXTRAS])
        .run();
      await handles
        .owners()
        .insert([...OWNERS])
        .run();
    },
    async unseed(): Promise<void> {
      await schema.destroyInstance().run();
    },
  };
}
