import type { Dialect, SqlSyntax } from "../types";
import { type Flavour, MYSQL } from "./flavour";
import { SessionOf } from "./session";
import { SqlCoreOf } from "./sql-core";
import { JsonOf } from "./sql-json";
import { ScalarOf } from "./sql-scalar";
import { TimeOf } from "./sql-time";
import { RowsOf } from "./sql-rows";
import { errors } from "./errors";
import { DdlOf } from "./ddl";
import { CatalogOf } from "./catalog";
import { ExternalOf } from "./external";
import { CaptureOf } from "./capture";

export type { EscapedKeys, Flavour, Held, MemberPath } from "./flavour";

/** The dialect of an engine of the MySQL family, from what it spells its own way. */
export function FamilyDialect(flavour: Flavour): Dialect {
  const sql: SqlSyntax = {
    ...SqlCoreOf(flavour),
    json: JsonOf(flavour),
    scalar: ScalarOf(flavour),
    time: TimeOf(flavour),
    rows: RowsOf(flavour),
  };
  return {
    id: flavour.id,
    name: flavour.name,
    session: SessionOf(flavour),
    sql,
    errors,
    ddl: DdlOf(flavour, sql),
    catalog: CatalogOf(flavour),
    external: ExternalOf(flavour),
    capture: CaptureOf(flavour, sql),
  };
}

/** MySQL 8.4 LTS and 9.7 LTS. */
export const mysql = FamilyDialect(MYSQL);
