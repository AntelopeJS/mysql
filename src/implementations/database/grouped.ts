import type { InPlaceSyntax, Walk } from "../../dialect/sql-types";
import { type Sql, ident, int, join, sql } from "../../statement";
import { ArrayOf, BOOL, TEXT } from "./types";
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

const COMMA = sql`, `;
const AND = sql` AND `;

/**
 * The rows times distinct keys of one outer row from which its groups are looked up by key. The
 * lookup materializes every row of the table its uncorrelated conjuncts keep, once per statement,
 * which costs more than reading a few small groups' rows once each.
 */
const KEYED_GROUPS_FROM = 2 ** 20;

/**
 * A grouped relation's distinct keys, walked: each part's text in the relation's rows, the walk
 * of the distinct keys, and each part's text in the walked key. A part's text is the text a dedup
 * compares it by, which the walk carries exactly, where a JSON value read back from it is
 * reformatted.
 */
interface WalkedKeys {
  readonly texts: readonly Sql[];
  readonly walk: Walk;
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
  const walk = dialect.sql.json.walk(
    "elements",
    sql`(${Render(keys)})`,
    context.nextAlias(),
  );
  const source = new JsonRowSource(dialect, {
    sql: walk.value,
    type: key.type,
  });
  return {
    texts,
    walk,
    walked: texts.map((_, part) => source.field(KeyName(part)).sql),
  };
}

/**
 * One group: the grouped select restricted to the rows whose texts are the walked key's. It reads
 * every row of the relation once per group.
 */
function ScannedGroup(
  relation: Relation,
  keys: WalkedKeys,
  context: DecodingContext,
): Sql {
  const rows = context.dialect.sql.rows;
  return Render({
    ...relation,
    groupBy: keys.texts.map((text) => ({ sql: text, type: TEXT })),
    where: [
      ...relation.where,
      ...keys.texts.map((text, part) =>
        rows.nullSafeEqual(text, keys.walked[part]),
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
  const free = relation.where.filter((conjunct) =>
    context.readsNoOuterRow(conjunct),
  );
  const correlated = relation.where.filter(
    (conjunct) => !context.readsNoOuterRow(conjunct),
  );
  const alias = ident(relation.alias);
  const select = join(
    [
      sql`${inPlace.hash(keys.texts[0])} AS ${ident(hashed)}`,
      ...keys.texts.map((text, part) => sql`${text} AS ${ident(parts[part])}`),
      sql`${alias}.*`,
    ],
    COMMA,
  );
  const where = free.length > 0 ? sql` WHERE ${join(free, AND)}` : sql``;
  const rows = inPlace.materialized(
    sql`SELECT ${select} FROM ${relation.from} AS ${alias}${where}`,
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

/** Whether one outer row's groups are many and large enough to look up by key. */
function ManyGroups(relation: Relation, keys: WalkedKeys): Sql {
  const counted = SetProjection(Ungrouped(relation), {
    sql: sql`COUNT(*) * COUNT(DISTINCT ${join(keys.texts, COMMA)}) >= ${int(KEYED_GROUPS_FROM)}`,
    type: BOOL,
  });
  return sql`(${Render(counted)})`;
}

/** Each walked key's group, as `group` reads it, collected in the walk's order. */
function Groups(
  relation: Relation,
  keys: WalkedKeys,
  group: Sql,
  context: DecodingContext,
): Sql {
  const value = CurrentValue(relation);
  const element = AsJson(context.dialect, {
    sql: sql`(${group})`,
    type: value.type,
  });
  return keys.walk.aggregate(
    Collected(context.dialect, keys.walk.ordinal, element.sql),
  );
}

/**
 * Collects a grouped relation's groups without a derived table over them: a walk of the distinct
 * keys reads the outer row, and each key's group is a subquery of its own, so it reads it too.
 * The session leaves `ONLY_FULL_GROUP_BY` off, so the mapper still reads a term.
 *
 * A relation that reads a table the adapter owns, with no join, looks each group up by key once
 * the outer row's rows times keys reach {@link KEYED_GROUPS_FROM}; below that, and for any other
 * relation, each group scans the rows.
 */
export function GroupedInPlace(
  relation: Relation,
  inPlace: InPlaceSyntax,
  context: DecodingContext,
): Compiled {
  const keys = WalkedKeysOf(relation, inPlace, context);
  const type = ArrayOf(CurrentValue(relation).type);
  const scanned = Groups(
    relation,
    keys,
    ScannedGroup(relation, keys, context),
    context,
  );
  const table = relation.table;
  if (!table || relation.joins.length > 0) {
    return { sql: scanned, type };
  }
  const keyed = Groups(
    relation,
    keys,
    KeyedGroup(relation, table, keys, inPlace, context),
    context,
  );
  return {
    sql: sql`(CASE WHEN ${ManyGroups(relation, keys)} THEN ${keyed} ELSE ${scanned} END)`,
    type,
  };
}
