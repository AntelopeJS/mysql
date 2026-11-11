import type { Dialect } from "../types";
import { session } from "./session";
import { sqlCore } from "./sql-core";
import { json } from "./sql-json";
import { scalar } from "./sql-scalar";
import { time } from "./sql-time";
import { rows } from "./sql-rows";
import { errors } from "./errors";
import { ddl } from "./ddl";
import { catalog } from "./catalog";
import { external } from "./external";

/** MySQL 8.4 LTS and 9.7 LTS. */
export const mysql: Dialect = {
  id: "mysql",
  session,
  sql: { ...sqlCore, json, scalar, time, rows },
  errors,
  ddl,
  catalog,
  external,
};
