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
 * The shallow merge of two objects from the members of both in order, the left's first, each kept
 * only where no later member has its decoded key, so the last member of a key named twice wins as
 * when MySQL stores the object. Only the keys are listed together; each value is read by its place
 * in its own side, so a value nests no deeper than the side that holds it.
 */
export function LastMembers(
  flavour: Flavour,
  memberKeys: (object: Sql) => Sql,
  leftSide: Sql,
  rightSide: Sql,
  alias: string,
): Sql {
  const names = sql`JSON_TABLE(JSON_MERGE_PRESERVE(${memberKeys(leftSide)}, ${memberKeys(rightSide)}), '$[*]' ${NAME_COLUMNS})`;
  const [key, later, left, right] = ["k", "n", "l", "r"].map((suffix) =>
    ident(`${alias}_${suffix}`),
  );
  const ordinal = sql`${key}.${ORDINAL}`;
  const name = sql`${key}.${NAME}`;
  const superseded = sql`EXISTS (SELECT 1 FROM ${names} AS ${later} WHERE ${later}.${NAME} COLLATE ${ident(flavour.binaryCollation)} = ${name} AND ${later}.${ORDINAL} > ${ordinal})`;
  const leftCount = sql`JSON_LENGTH(${leftSide})`;
  const values = sql`LEFT JOIN ${MemberValues(leftSide)} AS ${left} ON ${left}.${ORDINAL} = ${ordinal} LEFT JOIN ${MemberValues(rightSide)} AS ${right} ON ${right}.${ORDINAL} = ${ordinal} - ${leftCount}`;
  const value = flavour.tabled(
    sql`IF(${ordinal} > ${leftCount}, ${right}.${VALUE}, ${left}.${VALUE})`,
  );
  return sql`(SELECT COALESCE(JSON_OBJECTAGG(${name}, ${value}), JSON_OBJECT()) FROM ${names} AS ${key} ${values} WHERE NOT ${superseded})`;
}
