import { Schema } from "@antelopejs/interface-database/schema";

const SCHEMA_ID = "outer_row";
export const INSTANCE = "one";
const ITEMS = 24;
const VIEW_KINDS = 4;
const KIND_COUNT = 3;
/** Items of 1 view are 1, 5, 9…; every other one writes its tag with its keys reversed. */
const TAG_ORDERS = 8;
const NOTED_ITEM = 2;
export const NOTED_VIEWS = NOTED_ITEM % VIEW_KINDS;

export interface Item {
  _id: string;
  slug: string;
  kind: string | null;
  views: number;
  tag?: Record<string, number>;
  note?: null;
}

export interface Owner {
  _id: string;
  take: number;
}

const schema = new Schema<{ items: Item; owners: Owner }>(SCHEMA_ID, {
  items: {
    fields: { slug: "string", kind: "string", views: "number" },
    indexes: { kindViews: { fields: ["kind", "views"] } },
  },
  owners: { fields: { take: "number" }, indexes: {} },
});

export function Items() {
  return schema.instance(INSTANCE).table("items");
}

export function Owners() {
  return schema.instance(INSTANCE).table("owners");
}

const KINDS = ["a", "b", "c"];

/**
 * Item `n` has `n % 4` views and kind `a`, `b` or `c` by `n % 3`, so each view count meets every
 * kind; one more item of 3 views has no kind, which a dedup and a group keep as a value of its own.
 * An item of 1 view has an undeclared `tag`, one document written with its keys in either order.
 * Item 2 alone holds an undeclared `note`, a JSON null, which every other item of 2 views lacks.
 */
const ITEM_ROWS: Item[] = [
  ...Array.from({ length: ITEMS }, (_, n) => {
    const item: Item = {
      _id: `i${n}`,
      slug: `slug-${String(n).padStart(2, "0")}`,
      kind: KINDS[n % KIND_COUNT],
      views: n % VIEW_KINDS,
    };
    if (item.views === 1) {
      item.tag = n % TAG_ORDERS === 1 ? { x: 1, y: 2 } : { y: 2, x: 1 };
    }
    if (n === NOTED_ITEM) {
      item.note = null;
    }
    return item;
  }),
  { _id: "unkinded", slug: "slug-99", kind: null, views: 3 },
];

/** `o3` takes a view count no item has, so every nested query of it reads no row. */
export const OWNERS: Owner[] = [
  { _id: "o1", take: 2 },
  { _id: "o2", take: 0 },
  { _id: "o3", take: 9 },
  { _id: "o4", take: 3 },
  { _id: "o5", take: 1 },
];

export function Viewed(take: number): Item[] {
  return ITEM_ROWS.filter((item) => item.views === take);
}

/** The items in the order of their slugs. */
export function BySlug(items: readonly Item[]): Item[] {
  return [...items].sort((left, right) => left.slug.localeCompare(right.slug));
}

/** Every item in the order of its slug. */
export function AllBySlug(): Item[] {
  return BySlug(ITEM_ROWS);
}

/** Orders kinds by their text, a missing kind as `null`, which a result is sorted by to compare. */
export function ByText(left: string | null, right: string | null): number {
  return String(left).localeCompare(String(right));
}

export function KindsViewed(take: number): (string | null)[] {
  return [...new Set(Viewed(take).map((item) => item.kind))].sort(ByText);
}

/** An item as a nested query that reads it whole answers it. */
export function Stored(item: Item): Item & { _instance: string } {
  return { ...item, _instance: INSTANCE };
}

export interface KindCount {
  kind: string | null;
  count: number;
}

/** How many of the items have each kind, by the kind's text. */
export function CountsByKind(items: readonly Item[]): KindCount[] {
  const counts = new Map<string | null, number>();
  for (const item of items) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }
  return [...counts]
    .map(([kind, count]) => ({ kind, count }))
    .sort((left, right) => ByText(left.kind, right.kind));
}

/** Groups keyed by kind, sorted by the kind's text so two reads compare whatever their order. */
export function SortedByKind<T extends { kind: string | null }>(
  groups: readonly T[],
): T[] {
  return [...groups].sort((left, right) => ByText(left.kind, right.kind));
}

export async function Seed(): Promise<void> {
  await schema.createInstance(INSTANCE).run();
  await Items().insert(ITEM_ROWS).run();
  await Owners().insert(OWNERS).run();
}

export async function Unseed(): Promise<void> {
  await schema.destroyInstance(INSTANCE).run();
}
