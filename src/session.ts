import type { Dialect } from "./dialect";
import { GetDialect, Prepares, Read, type Row } from "./connection";
import type { Sql } from "./statement";

/**
 * Where the catalog reads which relations an account sees and what it may do with each: the
 * dialect the server speaks, and how a statement's rows are read and whether the server would take
 * one. The module's pool is one; a probe's own connection is another.
 */
export interface Session {
  readonly dialect: Dialect;
  read(statement: Sql): Promise<Row[]>;
  prepares(statement: Sql): Promise<boolean>;
}

/** The module's pool as a {@link Session}, or a refusal with why there is none. */
export function PoolSession(): Session {
  return {
    dialect: GetDialect(),
    read: (statement) => Read(statement),
    prepares: Prepares,
  };
}
