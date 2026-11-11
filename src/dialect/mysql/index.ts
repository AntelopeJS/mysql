import type { Dialect } from "../types";
import { session } from "./session";
import { sqlCore } from "./sql-core";

/** MySQL 8.4 LTS and 9.7 LTS. */
export const mysql: Dialect = {
  id: "mysql",
  session,
  sql: sqlCore,
};
