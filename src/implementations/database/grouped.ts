import type { HeldKeys, InPlaceSyntax, Walk } from "../../dialect/sql-types";
import { type Sql, ident, int, join, sql } from "../../statement";
import { ArrayOf, BOOL, FLOAT, OPAQUE, TEXT } from "./types";
import { Collected } from "./json";
import { AsJson } from "./readings";
import { type Compiled, QualifiedColumn } from "./sql";
import type { DecodingContext } from "./context";
import { BuildDocument, JsonRowSource } from "./row-source";
import {
  CurrentValue,
  type Relation,
  SetProjection,
  type TableOrigin,
} from "./relation";
import { FromItem, JoinOn, Render } from "./render";
import { ID_COLUMN, INSTANCE_COLUMN } from "./utils";

const COMMA = sql`, `;
const AND = sql` AND `;

/**
 * The rows times distinct keys of one outer row below which its groups are never looked up by key,
 * so a statement of small groups never counts the rows a lookup would materialize, and never looks
 * up keys that every outer row shares, each of which matches the rows of every outer row.
 */
const KEYED_GROUPS_FROM = 2 ** 20;

/** The columns that name a row of a table the adapter owns, in its primary key's order. */
const IDENTITY = [INSTANCE_COLUMN, ID_COLUMN];

/**
 * A grouped relation's distinct keys, walked: each part's text in the relation's rows, the walk
 * of the distinct keys, and each part's text in the walked key. A part's text is the text a dedup
 * compares it by, which the walk carries exactly, where a JSON value read back from it is
 * reformatted.
 */
interface WalkedKeys {
  readonly texts: readonly Sql[];
  readonly walk: Walk;
  readonly alias: string;
  readonly walked: readonly Sql[];
}

function KeyName(part: number): string {
  return `k${part}`;
}

/** The rows a grouped relation folds, before they are grouped. */
function Ungrouped(relation: Relation): Relation {
  return { ...relation, groupBy: [], aggregated: false };
}

function WalkedKeysOf(
  relation: Relation,
  inPlace: InPlaceSyntax,
  context: DecodingContext,
): WalkedKeys {
  const dialect = context.dialect;
  const texts = relation.groupBy.map((term) =>
    inPlace.dedupText(AsJson(dialect, term).sql),
  );
  const key = BuildDocument(
    dialect,
    texts.map((text, part) => ({ name: KeyName(part), sql: text, type: TEXT })),
  );
  const keys = SetProjection(Ungrouped(relation), {
    sql: inPlace.collect(key.sql, { distinct: true }),
    type: ArrayOf(key.type),
  });
  const alias = context.nextAlias();
  const walk = dialect.sql.json.walk("elements", sql`(${Render(keys)})`, alias);
  const source = new JsonRowSource(dialect, {
    sql: walk.value,
    type: key.type,
  });
  return {
    texts,
    walk,
    alias,
    walked: texts.map((_, part) => source.field(KeyName(part)).sql),
  };
}

/** The grouped select restricted to the rows whose texts are the walked key's. */
function GroupOf(
  relation: Relation,
  keys: WalkedKeys,
  context: DecodingContext,
): Relation {
  const rows = context.dialect.sql.rows;
  return {
    ...relation,
    groupBy: keys.texts.map((text) => ({ sql: text, type: TEXT })),
    where: [
      ...relation.where,
      ...keys.texts.map((text, part) =>
        rows.nullSafeEqual(text, keys.walked[part]),
      ),
    ],
  };
}

/** One group, which reads every row of the relation once per group. */
function ScannedGroup(
  relation: Relation,
  keys: WalkedKeys,
  context: DecodingContext,
): Sql {
  return Render(GroupOf(relation, keys, context));
}

/**
 * The outer row's rows, held once as the hash of each row's first part's text beside the row's
 * identity: the one-row table at an alias of its own, as a FROM item, and the array it holds.
 */
interface HeldRows {
  readonly item: Sql;
  readonly keys: HeldKeys;
}

function HeldRowsOf(
  relation: Relation,
  keys: WalkedKeys,
  inPlace: InPlaceSyntax,
  context: DecodingContext,
): HeldRows {
  const identity = IDENTITY.map((name) =>
    QualifiedColumn(relation.alias, name),
  );
  const element = inPlace.hashedKey(inPlace.hash(keys.texts[0]), identity);
  const array = SetProjection(Ungrouped(relation), {
    sql: inPlace.collect(element, { distinct: false }),
    type: OPAQUE,
  });
  const alias = context.nextAlias();
  const held = inPlace.held(sql`(${Render(array)})`, identity.length, alias);
  return { item: FromItem(held.from, alias), keys: held };
}

/**
 * One group, read through the outer row's {@link HeldRows}: the held rows whose hash is the walked
 * key's are joined to the table by identity, so each group reads the held array and its own rows,
 * whether or not an index serves a condition that reads the outer row. Every conjunct still tests
 * the rows it reads, and the full text decides, so two keys that share a hash stay apart.
 */
function HeldGroup(
  relation: Relation,
  keys: WalkedKeys,
  held: HeldKeys,
  inPlace: InPlaceSyntax,
  context: DecodingContext,
): Sql {
  const lookup = context.nextAlias();
  const one = inPlace.hashRow(keys.walked[0], lookup);
  const alias = context.nextAlias();
  const rows = held.rows(alias);
  const identity = IDENTITY.map(
    (name, part) =>
      sql`${QualifiedColumn(relation.alias, name)} = ${rows.key[part]}`,
  );
  return Render({
    ...GroupOf(relation, keys, context),
    from: one.from,
    alias: lookup,
    joins: [
      JoinOn(
        "JOIN",
        FromItem(rows.from, alias),
        sql`${rows.hash} = ${one.hash}`,
      ),
      JoinOn(
        "JOIN",
        FromItem(relation.from, relation.alias),
        join(identity, AND),
      ),
    ],
  });
}

/** Each name, prefixed until it is free of every column of the table, which compare without case. */
function FreeNames(table: TableOrigin, names: readonly string[]): string[] {
  const taken = new Set(
    [...table.plan.columns, ...table.plan.keyColumns].map((column) =>
      column.name.toLowerCase(),
    ),
  );
  return names.map((base) => {
    let name = `_${base}`;
    while (taken.has(name)) {
      name = `_${name}`;
    }
    return name;
  });
}

/**
 * The `FROM` and `WHERE` of the relation's table, kept by the conjuncts known to read no outer
 * row, under the relation's own alias: what a lookup by key materializes once per statement.
 */
function OuterFreeRows(relation: Relation, context: DecodingContext): Sql {
  const free = relation.where.filter((conjunct) =>
    context.readsNoOuterRow(conjunct),
  );
  const where = free.length > 0 ? sql` WHERE ${join(free, AND)}` : sql``;
  return sql`FROM ${relation.from} AS ${ident(relation.alias)}${where}`;
}

/**
 * One group, looked up by key in a derived table of the relation's rows that reads no outer row:
 * the engine materializes it once per statement and keys it on the hash of the first part's text,
 * so each group reads its own rows only. The derived table keeps the relation's alias and every
 * column, so each term and each conjunct left outside it still resolves. A conjunct that may read
 * the outer row stays outside it, under `IS TRUE`, which keeps the same rows and stops the engine
 * keying the derived table on it.
 */
function KeyedGroup(
  relation: Relation,
  table: TableOrigin,
  keys: WalkedKeys,
  inPlace: InPlaceSyntax,
  context: DecodingContext,
): Sql {
  const [hashed, ...parts] = FreeNames(table, [
    "h",
    ...keys.texts.map((_, part) => KeyName(part)),
  ]);
  const correlated = relation.where.filter(
    (conjunct) => !context.readsNoOuterRow(conjunct),
  );
  const select = join(
    [
      sql`${inPlace.hash(keys.texts[0])} AS ${ident(hashed)}`,
      ...keys.texts.map((text, part) => sql`${text} AS ${ident(parts[part])}`),
      sql`${ident(relation.alias)}.*`,
    ],
    COMMA,
  );
  const rows = inPlace.materialized(
    sql`SELECT ${select} ${OuterFreeRows(relation, context)}`,
  );
  const lookup = context.nextAlias();
  const one = inPlace.hashRow(keys.walked[0], lookup);
  const on = sql`${QualifiedColumn(relation.alias, hashed)} = ${one.hash}`;
  const columns = parts.map((name) => QualifiedColumn(relation.alias, name));
  return Render({
    ...relation,
    from: one.from,
    alias: lookup,
    joins: [JoinOn("JOIN", FromItem(sql`(${rows})`, relation.alias), on)],
    where: [
      ...columns.map((column, part) =>
        context.dialect.sql.rows.nullSafeEqual(column, keys.walked[part]),
      ),
      ...(correlated.length > 0
        ? [sql`(${join(correlated, AND)}) IS TRUE`]
        : []),
    ],
    groupBy: columns.map((column) => ({ sql: column, type: TEXT })),
  });
}

/**
 * The rows times distinct keys of each row of the query outside, summed once for the statement,
 * where those rows are a plain select that every outer row the groups are read for is one of.
 */
function EveryOuterRow(outer: Relation, perRow: Sql): Sql | undefined {
  const plain =
    !outer.aggregated &&
    !outer.distinct &&
    outer.groupBy.length === 0 &&
    outer.limit === undefined &&
    outer.offset === undefined;
  if (!plain) {
    return undefined;
  }
  const summed = SetProjection(
    { ...outer, orderBy: [], locked: false },
    { sql: sql`SUM((${perRow}))`, type: FLOAT },
  );
  return sql`(${Render(summed)})`;
}

/**
 * Whether scanning costs more than materializing the rows {@link OuterFreeRows} keeps once for the
 * statement, which the engine counts once per statement and only once one outer row's groups reach
 * {@link KEYED_GROUPS_FROM}. Where the outer rows are known, the scan's cost is that of every outer
 * row's groups, which share the one materialized table; otherwise it is this outer row's.
 */
function ManyGroups(
  relation: Relation,
  keys: WalkedKeys,
  context: DecodingContext,
  outerRows: Relation | undefined,
): Sql {
  const scanned = sql`COUNT(*) * COUNT(DISTINCT ${join(keys.texts, COMMA)})`;
  const materialized = sql`(SELECT COUNT(*) ${OuterFreeRows(relation, context)})`;
  const perRow = SetProjection(Ungrouped(relation), {
    sql: scanned,
    type: FLOAT,
  });
  const statement = outerRows && EveryOuterRow(outerRows, Render(perRow));
  const counted = SetProjection(Ungrouped(relation), {
    sql: sql`(CASE WHEN ${scanned} < ${int(KEYED_GROUPS_FROM)} THEN FALSE ELSE ${statement ?? scanned} >= ${materialized} END)`,
    type: BOOL,
  });
  return sql`(${Render(counted)})`;
}

/**
 * Each walked key's group, as `group` reads it, collected in the walk's order. `held` is a one-row
 * FROM item the groups read, joined ahead of the walk.
 */
function Groups(
  relation: Relation,
  keys: WalkedKeys,
  group: Sql,
  context: DecodingContext,
  held?: Sql,
): Sql {
  const value = CurrentValue(relation);
  const element = AsJson(context.dialect, {
    sql: sql`(${group})`,
    type: value.type,
  });
  const select = Collected(context.dialect, keys.walk.ordinal, element.sql);
  if (!held) {
    return keys.walk.aggregate(select);
  }
  return sql`(SELECT ${select} FROM ${held} CROSS JOIN ${FromItem(keys.walk.from, keys.alias)})`;
}

/**
 * Collects a grouped relation's groups without a derived table over them: a walk of the distinct
 * keys reads the outer row, and each key's group is a subquery of its own, so it reads it too.
 * The session leaves `ONLY_FULL_GROUP_BY` off, so the mapper still reads a term.
 *
 * A relation that reads a table the adapter owns, with no join, looks each group up by key once
 * the outer row's rows times keys reach {@link KEYED_GROUPS_FROM}, and the scan's cost over
 * `outerRows`, the rows of the query outside where they are known, reaches the rows the lookup
 * materializes; below that, each group reads the outer row's {@link HeldRows}. Any other relation
 * scans its rows once per group.
 */
export function GroupedInPlace(
  relation: Relation,
  inPlace: InPlaceSyntax,
  context: DecodingContext,
  outerRows: Relation | undefined,
): Compiled {
  const keys = WalkedKeysOf(relation, inPlace, context);
  const type = ArrayOf(CurrentValue(relation).type);
  const table = relation.table;
  if (!table || relation.joins.length > 0) {
    const scanned = ScannedGroup(relation, keys, context);
    return { sql: Groups(relation, keys, scanned, context), type };
  }
  const held = HeldRowsOf(relation, keys, inPlace, context);
  const scanned = Groups(
    relation,
    keys,
    HeldGroup(relation, keys, held.keys, inPlace, context),
    context,
    held.item,
  );
  const keyed = Groups(
    relation,
    keys,
    KeyedGroup(relation, table, keys, inPlace, context),
    context,
  );
  const many = ManyGroups(relation, keys, context, outerRows);
  return {
    sql: sql`(CASE WHEN ${many} THEN ${keyed} ELSE ${scanned} END)`,
    type,
  };
}
