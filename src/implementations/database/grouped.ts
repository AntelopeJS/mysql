import type { InPlaceSyntax, Walk } from "../../dialect/sql-types";
import { type Sql, sql } from "../../statement";
import { ArrayOf, TEXT } from "./types";
import { Collected } from "./json";
import { AsJson } from "./readings";
import type { Compiled } from "./sql";
import type { DecodingContext } from "./context";
import { BuildDocument, JsonRowSource } from "./row-source";
import { CurrentValue, type Relation, SetProjection } from "./relation";
import { Render } from "./render";

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
 */
export function GroupedInPlace(
  relation: Relation,
  inPlace: InPlaceSyntax,
  context: DecodingContext,
): Compiled {
  const keys = WalkedKeysOf(relation, inPlace, context);
  return {
    sql: Groups(relation, keys, ScannedGroup(relation, keys, context), context),
    type: ArrayOf(CurrentValue(relation).type),
  };
}
