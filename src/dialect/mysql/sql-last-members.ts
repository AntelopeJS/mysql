import { type Sql, ident, sql } from "../../statement";
import type { Flavour } from "./flavour";

const ORDINAL = ident("ord");
const NAME = ident("name");
const VALUE = ident("value");
const NAME_COLUMNS = sql`COLUMNS (${ORDINAL} FOR ORDINALITY, ${NAME} LONGTEXT PATH '$')`;

function MemberValues(object: Sql): Sql {
  return sql`JSON_TABLE(${object}, '$.*' COLUMNS (${ORDINAL} FOR ORDINALITY, ${VALUE} JSON PATH '$'))`;
}

/**
 * Whether an object spells a key escaped, which `JSON_KEYS` lists as written and a path read may
 * miss, or names one decoded key twice: more members than distinct decoded keys among the
 * spellings `JSON_KEYS` lists, which never warns. An object that does neither is merged without
 * listing its members.
 */
export function EscapesOrRepeatsKey(
  flavour: Flavour,
  object: Sql,
  alias: string,
): Sql {
  const keys = ident(alias);
  const decoded = sql`${keys}.${NAME} COLLATE ${ident(flavour.binaryCollation)}`;
  return sql`(INSTR(JSON_KEYS(${object}), CHAR(92)) > 0 OR JSON_LENGTH(${object}) > (SELECT COUNT(DISTINCT ${decoded}) FROM JSON_TABLE(JSON_KEYS(${object}), '$[*]' ${NAME_COLUMNS}) AS ${keys}))`;
}

/**
 * The shallow merge of two objects from the members of both in order, the left's first. Each
 * decoded key stays where it first appears and takes the value of its last member, so the last
 * member of a key named twice wins as when MySQL stores the object, and the keys keep the order a
 * merge of objects naming each key once has. Only the keys are listed together; each value is read
 * by its place in its own side, so a value nests no deeper than the side that holds it.
 */
export function LastMembers(
  flavour: Flavour,
  memberKeys: (object: Sql) => Sql,
  leftSide: Sql,
  rightSide: Sql,
  alias: string,
): Sql {
  const names = sql`JSON_TABLE(JSON_MERGE_PRESERVE(${memberKeys(leftSide)}, ${memberKeys(rightSide)}), '$[*]' ${NAME_COLUMNS})`;
  const [key, other, left, right] = ["k", "n", "l", "r"].map((suffix) =>
    ident(`${alias}_${suffix}`),
  );
  const ordinal = sql`${key}.${ORDINAL}`;
  const name = sql`${key}.${NAME}`;
  const sameName = sql`${other}.${NAME} COLLATE ${ident(flavour.binaryCollation)} = ${name}`;
  const repeated = sql`EXISTS (SELECT 1 FROM ${names} AS ${other} WHERE ${sameName} AND ${other}.${ORDINAL} < ${ordinal})`;
  const last = sql`(SELECT MAX(${other}.${ORDINAL}) FROM ${names} AS ${other} WHERE ${sameName})`;
  const leftCount = sql`JSON_LENGTH(${leftSide})`;
  const valueAt = (side: Sql, held: Sql, place: Sql) =>
    sql`(SELECT ${held}.${VALUE} FROM ${MemberValues(side)} AS ${held} WHERE ${held}.${ORDINAL} = ${place})`;
  const value = flavour.tabled(
    sql`IF(${last} > ${leftCount}, ${valueAt(rightSide, right, sql`${last} - ${leftCount}`)}, ${valueAt(leftSide, left, last)})`,
  );
  return sql`(SELECT COALESCE(JSON_OBJECTAGG(${name}, ${value}), JSON_OBJECT()) FROM ${names} AS ${key} WHERE NOT ${repeated})`;
}
