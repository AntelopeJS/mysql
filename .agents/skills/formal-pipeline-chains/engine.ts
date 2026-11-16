import { createConnection, type RowDataPacket } from "mysql2/promise";

/** The engine of the server under test: `mariadb` or `mysql`. */
export type Engine = "mariadb" | "mysql";

const MARIADB = /mariadb/iu;

/**
 * The engine `MYSQL_TEST_URL` names, read from the server's version, or else the one the
 * `MYSQL_TEST_IMAGE` container runs, which is MySQL 8.4 when unset.
 */
export async function EngineOf(): Promise<Engine> {
  const url = process.env.MYSQL_TEST_URL;
  if (!url) {
    return MARIADB.test(process.env.MYSQL_TEST_IMAGE ?? "") ? "mariadb" : "mysql";
  }
  const connection = await createConnection(url);
  try {
    const [rows] = await connection.query<RowDataPacket[]>("SELECT VERSION() AS version");
    return MARIADB.test(String(rows[0]?.version)) ? "mariadb" : "mysql";
  } finally {
    await connection.end();
  }
}
