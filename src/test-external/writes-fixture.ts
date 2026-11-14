import { type Sql, ident, param, sql } from "../statement";
import { ExternalWriteError } from "../implementations/database/external-errors";
import { Native, NativeWrite } from "./sales";

export async function Failure(work: () => Promise<void>): Promise<Error> {
  try {
    await work();
  } catch (err) {
    if (err instanceof Error) {
      return err;
    }
    throw err;
  }
  throw new Error("the write was expected to fail");
}

/** {@link Failure} for a write the database refused, which the adapter reports as a typed error. */
export async function WriteFailure(
  work: () => Promise<void>,
): Promise<ExternalWriteError> {
  const failure = await Failure(work);
  if (failure instanceof ExternalWriteError) {
    return failure;
  }
  throw failure;
}

export function Rows(table: string): Sql {
  return sql`${ident("sales")}.${ident(table)}`;
}

export async function Reset(): Promise<void> {
  for (const table of [
    "w_items",
    "w_accounts",
    "w_serial",
    "w_lines",
    "w_events",
    "w_big",
  ]) {
    await NativeWrite(sql`DELETE FROM ${Rows(table)}`);
  }
}

/** The stored text of a row's columns, as the database's own rendering shows them. */
export async function Stored(id: string) {
  const [row] = await Native(
    sql`SELECT CAST(big AS CHAR) AS big, CAST(rating AS CHAR) AS rating, CAST(seen AS CHAR) AS seen,
      CAST(at AS CHAR) AS at, CAST(raw AS CHAR) AS raw, CAST(tags AS CHAR) AS tags, code, upper_code
      FROM sales.w_accounts WHERE id = ${param(id)}`,
  );
  return row;
}

export async function Seeded(code: string): Promise<string> {
  await NativeWrite(
    sql`INSERT INTO sales.w_accounts (code, big, rating, seen, at, raw, tags)
     VALUES (${param(code)}, 9007199254740993, 0.1, '2026-01-01 10:00:00.123456', '2026-01-01 10:00:00.123456',
       '{"k": 1}', '["a"]')`,
  );
  const [row] = await Native(
    sql`SELECT CAST(id AS CHAR) AS id FROM sales.w_accounts WHERE code = ${param(code)}`,
  );
  return String(row.id);
}
