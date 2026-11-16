import fc from "fast-check";

import {
  type Chain,
  type Compare,
  type Doc,
  IdOf,
  type Expression,
  type FieldKind,
  type GroupSum,
  type Stage,
  type Terminal,
  type Write,
} from "./model";

/**
 * `optional` is a field some rows lack; `nullable` one some rows hold as a JSON null, which a
 * `pluck` drops from the document it keeps (see the known defect in pipeline-chains.test.ts).
 */
interface Field {
  readonly kind: FieldKind;
  readonly optional: boolean;
  readonly nullable?: boolean;
}

/**
 * What a chain has produced so far: its fields, the fields no two rows share, and whether the
 * order of its rows is defined. A stage is drawn only where it keeps the chain's answer defined:
 * a `slice` or an `nth` of rows in no defined order would let two engines both be right.
 */
interface Held {
  readonly fields: ReadonlyMap<string, Field>;
  readonly unique: ReadonlySet<string>;
  readonly ordered: boolean;
  /** A `merge` has run. */
  readonly merged: boolean;
  /** A `filterOuter` has run. */
  readonly outerFiltered: boolean;
  /** A `lookup` or a `lookupList` has run. */
  readonly looked: boolean;
}

const START: Held = {
  fields: new Map<string, Field>([
    ["_id", { kind: "text", optional: false }],
    ["slug", { kind: "text", optional: false }],
    ["n", { kind: "number", optional: false }],
    ["kind", { kind: "text", optional: true }],
    ["ownerId", { kind: "text", optional: true }],
    ["refs", { kind: "list", optional: false }],
  ]),
  unique: new Set(["_id", "slug"]),
  ordered: false,
  merged: false,
  outerFiltered: false,
  looked: false,
};

/** One draw of a stage: the numbers `Resolve` reads to choose a kind and its parameters. */
export interface Pick {
  readonly kind: number;
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly flag: boolean;
}

export interface Draw {
  readonly nested: boolean;
  readonly picks: readonly Pick[];
  readonly terminal: Pick;
}

const COMPARES: readonly Compare[] = ["eq", "ne", "gt", "lt"];
const EQUALITY: readonly Compare[] = ["eq", "ne"];
const MERGED = ["m", "o", "n"] as const;
const TEXTS = ["a", "b", "c"] as const;
const MAX_PICKS = 6;
const SPREAD = 1000;

const PICK = fc.record({
  kind: fc.nat(SPREAD),
  a: fc.nat(SPREAD),
  b: fc.nat(SPREAD),
  c: fc.nat(SPREAD),
  flag: fc.boolean(),
});

export const DRAW: fc.Arbitrary<Draw> = fc.record({
  nested: fc.boolean(),
  picks: fc.array(PICK, { maxLength: MAX_PICKS }),
  terminal: PICK,
});

function Comparable(field: Field): boolean {
  return field.kind === "number" || field.kind === "text";
}

function Named(held: Held, wanted: (field: Field) => boolean): string[] {
  return [...held.fields]
    .filter(([, field]) => wanted(field))
    .map(([name]) => name);
}

function At<T>(list: readonly T[], index: number): T {
  const found = list[index % list.length];
  if (found === undefined) {
    throw new Error("a draw chose from an empty list");
  }
  return found;
}

function ValueOf(name: string, field: Field, pick: Pick): number | string {
  if (field.kind === "number") {
    return pick.a % 5;
  }
  if (name === "slug") {
    return `s${String(pick.a % 13).padStart(2, "0")}`;
  }
  if (name === "_id") {
    return `${pick.a % 2 === 0 ? "i" : "x"}${String(pick.a % 10).padStart(2, "0")}`;
  }
  return At(TEXTS, pick.a);
}

function Subset(
  names: readonly string[],
  mask: number,
  atMost: number,
): string[] {
  const chosen = names
    .filter((_, index) => (mask >> index) % 2 === 1)
    .slice(0, atMost);
  return chosen.length > 0 ? chosen : [At(names, mask)];
}

function WithFields(
  held: Held,
  fields: Map<string, Field>,
  unique: Iterable<string>,
  ordered: boolean,
): Held {
  const kept = new Set([...unique].filter((name) => fields.has(name)));
  return { ...held, fields, unique: kept, ordered };
}

/** A drawn stage and what the chain holds once it has run. */
interface Step {
  readonly stage: Stage;
  readonly held: Held;
}

/** Where a chain runs: for each owner of a nested query, or before `changes()` of a feed. */
interface Context {
  readonly nested: boolean;
  readonly feed: boolean;
}

type Resolver = (held: Held, pick: Pick, context: Context) => Step | undefined;

function ExpressionOf(held: Held, pick: Pick, context: Context): Expression {
  const numbers = Named(held, (field) => field.kind === "number");
  const kinds = ["number", "text"];
  if (!context.feed) {
    kinds.push("keys");
  }
  if (numbers.length > 0) {
    kinds.push("add", "mul");
    if (!context.feed) {
      kinds.push("owners", "label");
    }
    if (context.nested) {
      kinds.push("outer");
    }
  }
  const kind = At(kinds, pick.b);
  switch (kind) {
    case "number":
      return { kind, value: pick.c % 4 };
    case "text":
      return { kind, value: At(["x", "y", "z"], pick.c) };
    case "add":
    case "mul":
      return { kind, field: At(numbers, pick.c), by: (pick.a % 3) + 1 };
    case "keys":
      return { kind };
    case "owners":
    case "label":
    case "outer":
      return { kind, field: At(numbers, pick.c) };
    default:
      throw new Error(`no expression of kind ${kind}`);
  }
}

const merge: Resolver = (held, pick, context) => {
  const expression = ExpressionOf(held, pick, context);
  const textual = expression.kind === "text" || expression.kind === "label";
  const name = At(textual ? ["m", "o"] : MERGED, pick.a);
  const fields = new Map(held.fields);
  fields.set(name, {
    kind: textual ? "text" : "number",
    optional: false,
    nullable: expression.kind === "label",
  });
  const unique = [...held.unique].filter((field) => field !== name);
  return {
    stage: { kind: "merge", name, expression },
    held: { ...WithFields(held, fields, unique, held.ordered), merged: true },
  };
};

const group: Resolver = (held, pick, context) => {
  const keys = Named(held, (field) => Comparable(field));
  const numbers = Named(held, (field) => field.kind === "number");
  const field = At(keys, pick.a);
  const source = held.fields.get(field);
  let sum: GroupSum | undefined;
  if (numbers.length > 0 && pick.b % 3 !== 0) {
    sum = {
      field: At(numbers, pick.c),
      withOuter: context.nested && pick.flag,
    };
  }
  const key: Field = {
    kind: source?.kind ?? "text",
    optional: false,
    nullable: source?.optional === true || source?.nullable === true,
  };
  const fields = new Map<string, Field>([
    ["k", key],
    ["c", { kind: "number", optional: false }],
  ]);
  if (sum) {
    fields.set("t", { kind: "number", optional: false });
  }
  const unique = key.nullable ? [] : ["k"];
  return {
    stage: { kind: "group", field, sum },
    held: WithFields(held, fields, unique, false),
  };
};

const filter: Resolver = (held, pick) => {
  const name = At(
    Named(held, (field) => Comparable(field)),
    pick.a,
  );
  const picked = held.fields.get(name);
  if (!picked) {
    return undefined;
  }
  const compare =
    picked.kind === "number" || pick.flag
      ? At(COMPARES, pick.b)
      : At(EQUALITY, pick.b);
  return {
    stage: {
      kind: "filter",
      field: name,
      compare,
      value: ValueOf(name, picked, pick),
    },
    held,
  };
};

const filterOuter: Resolver = (held, pick) => ({
  stage: {
    kind: "filterOuter",
    field: At(
      Named(held, (field) => field.kind === "number"),
      pick.a,
    ),
    compare: At(COMPARES, pick.b),
  },
  held: { ...held, outerFiltered: true },
});

const orderBy: Resolver = (held, pick) => {
  const comparable = Named(held, (field) => Comparable(field));
  const pool =
    pick.flag && held.unique.size > 0 ? [...held.unique] : comparable;
  const field = At(pool, pick.a);
  return {
    stage: { kind: "orderBy", field, direction: pick.flag ? "desc" : "asc" },
    held: { ...held, ordered: held.ordered || held.unique.has(field) },
  };
};

const slice: Resolver = (held, pick) => ({
  stage: {
    kind: "slice",
    offset: pick.a % 4,
    count: pick.b % 3 === 0 ? undefined : pick.b % 5,
  },
  held,
});

const sliceOuter: Resolver = (held) => ({
  stage: { kind: "sliceOuter" },
  held,
});

/** The fields a `pluck` or a `without` keeps, from the names its draw chose. */
function Kept(held: Held, chosen: readonly string[], keep: boolean): Held {
  const fields = new Map(
    [...held.fields].filter(([name]) => chosen.includes(name) === keep),
  );
  return WithFields(held, fields, held.unique, held.ordered);
}

const pluck: Resolver = (held, pick) => {
  const names = [...held.fields.keys()];
  const chosen = Subset(names, pick.a, names.length);
  if (chosen.some((name) => held.fields.get(name)?.nullable)) {
    return undefined;
  }
  return {
    stage: { kind: "pluck", fields: chosen },
    held: Kept(held, chosen, true),
  };
};

const without: Resolver = (held, pick) => {
  const names = [...held.fields.keys()];
  const chosen = Subset(names, pick.a, names.length - 1);
  if (chosen.length >= names.length) {
    return undefined;
  }
  return {
    stage: { kind: "without", fields: chosen },
    held: Kept(held, chosen, false),
  };
};

const lookup: Resolver = (held) => {
  const fields = new Map(held.fields);
  fields.set("ownerId", { kind: "doc", optional: false, nullable: true });
  return {
    stage: { kind: "lookup" },
    held: {
      ...WithFields(held, fields, held.unique, held.ordered),
      looked: true,
    },
  };
};

const lookupList: Resolver = (held) => {
  const fields = new Map(held.fields);
  fields.set("refs", { kind: "doc", optional: false });
  return {
    stage: { kind: "lookupList" },
    held: {
      ...WithFields(held, fields, held.unique, held.ordered),
      looked: true,
    },
  };
};

const union: Resolver = (held) => ({
  stage: { kind: "union" },
  held: WithFields(
    held,
    new Map(held.fields),
    [...held.unique].filter((name) => name === "_id" || name === "slug"),
    false,
  ),
});

const RESOLVERS = {
  filter,
  filterOuter,
  merge,
  orderBy,
  slice,
  sliceOuter,
  pluck,
  without,
  group,
  lookup,
  lookupList,
  union,
} satisfies Record<Stage["kind"], Resolver>;

const FEED_STAGES = new Set<Stage["kind"]>([
  "filter",
  "merge",
  "pluck",
  "without",
  "lookup",
]);

/**
 * The stages a draw may pick next, a kind listed more than once where it should be picked more
 * often: an unordered chain leans to an `orderBy`, and an ordered one to a `slice`.
 */
function Offered(held: Held, context: Context): Stage["kind"][] {
  const offered: Stage["kind"][] = ["pluck", "without", "union"];
  if (!held.looked) {
    offered.push("merge", "merge");
  }
  if (Named(held, (field) => Comparable(field)).length > 0) {
    offered.push("filter", "filter", "orderBy", "orderBy", "group");
    if (!held.ordered) {
      offered.push("orderBy", "orderBy");
    }
  }
  if (
    context.nested &&
    Named(held, (field) => field.kind === "number").length > 0
  ) {
    offered.push("filterOuter");
  }
  if (held.ordered) {
    offered.push("slice", "slice", "slice");
    if (context.nested) {
      offered.push("sliceOuter", "sliceOuter");
    }
  }
  if (held.fields.get("ownerId")?.kind === "text" && !held.merged) {
    offered.push("lookup");
  }
  if (held.fields.get("refs")?.kind === "list" && !held.merged) {
    offered.push("lookupList");
  }
  if (!context.feed) {
    return offered;
  }
  const boosted: Stage["kind"][] = held.looked
    ? offered
    : [...offered, "merge", "merge"];
  return boosted.filter((name) => FEED_STAGES.has(name));
}

function Resolved(held: Held, pick: Pick, context: Context): Step | undefined {
  return RESOLVERS[At(Offered(held, context), pick.kind)](held, pick, context);
}

function TerminalOf(held: Held, pick: Pick, nested: boolean): Terminal {
  const kinds: Terminal["kind"][] = ["rows", "rows", "count"];
  const answersWrong = nested && held.merged && held.outerFiltered;
  if (held.ordered && !answersWrong) {
    kinds.push("nth", "nth");
    if (nested) {
      kinds.push("nthOuter", "nthOuter");
    }
  }
  const kind = At(kinds, pick.kind);
  return kind === "nth" ? { kind, at: pick.a % 4 } : { kind };
}

/** A chain a draw describes, with whether its rows come in a defined order. */
export function Resolve(draw: Draw): Chain & { readonly ordered: boolean } {
  let held = START;
  const stages: Stage[] = [];
  for (const pick of draw.picks) {
    const next = Resolved(held, pick, { nested: draw.nested, feed: false });
    if (next) {
      stages.push(next.stage);
      held = next.held;
    }
  }
  return {
    nested: draw.nested,
    stages,
    terminal: TerminalOf(held, draw.terminal, draw.nested),
    ordered: held.ordered,
  };
}

export interface FeedDraw {
  readonly picks: readonly Pick[];
  readonly writes: readonly Pick[];
}

const MAX_WRITES = 5;

export const FEED_DRAW: fc.Arbitrary<FeedDraw> = fc.record({
  picks: fc.array(PICK, { maxLength: 5 }),
  writes: fc.array(PICK, { minLength: 1, maxLength: MAX_WRITES }),
});

/** The stages a feed accepts before `changes()`, drawn the way a chain is. */
export function ResolveFeed(draw: FeedDraw): readonly Stage[] {
  let held = START;
  const stages: Stage[] = [];
  for (const pick of draw.picks) {
    const next = Resolved(held, pick, { nested: false, feed: true });
    if (next) {
      stages.push(next.stage);
      held = next.held;
    }
  }
  return stages;
}

const IDS = ["i00", "i01", "i02", "i03", "x00", "x01"] as const;
const OWNER_IDS = ["o1", "o2", "o3", "o4", "missing"] as const;

function NewDoc(id: string, pick: Pick): Doc {
  const doc: Doc = { _id: id, n: pick.a % 4, slug: `s-${id}` };
  if (pick.b % 4 !== 3) {
    doc.kind = At(TEXTS, pick.b);
  }
  if (pick.c % 6 !== 5) {
    doc.ownerId = At(OWNER_IDS, pick.c);
  }
  return doc;
}

function Changed(doc: Doc, pick: Pick): Doc {
  const changes: Doc = {};
  if (pick.a % 3 === 0) {
    changes.n = (Number(doc.n) + 1 + (pick.b % 3)) % 5;
  } else if (pick.a % 3 === 1) {
    changes.kind = At(
      TEXTS.filter((text) => text !== doc.kind),
      pick.b,
    );
  } else {
    changes.ownerId = At(
      OWNER_IDS.filter((owner) => owner !== doc.ownerId),
      pick.c,
    );
  }
  return changes;
}

/** The writes a draw makes, each of a row the table has or lacks at that point of the script. */
export function Script(draw: FeedDraw): Write[] {
  const table = new Map<string, Doc>();
  const writes: Write[] = [];
  for (const pick of draw.writes) {
    const present = [...table.keys()];
    const absent = IDS.filter((id) => !table.has(id));
    const wanted = At(
      ["insert", "insert", "update", "update", "delete"],
      pick.kind,
    );
    if ((wanted === "insert" || present.length === 0) && absent.length > 0) {
      const doc = NewDoc(At(absent, pick.a), pick);
      table.set(IdOf(doc), doc);
      writes.push({ kind: "insert", doc });
    } else if (present.length > 0) {
      const id = At(present, pick.a);
      const doc = table.get(id) ?? {};
      if (wanted === "delete") {
        table.delete(id);
        writes.push({ kind: "delete", id });
      } else {
        const changes = Changed(doc, pick);
        table.set(id, { ...doc, ...changes });
        writes.push({ kind: "update", id, changes });
      }
    }
  }
  return writes;
}
