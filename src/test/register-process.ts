import { Logger } from "../logger";
import { Connect, Disconnect } from "../connection";
import { Schemas, WaitForIndexes } from "../implementations/database/schema";
import { CONTENDED, SCHEMA_VARIABLE, URL_VARIABLE } from "./contention-schema";

/**
 * A second module instance in a process of its own: it connects to the database the test names,
 * registers the contended schema, waits for its index phase and disconnects. It prints the module's
 * information lines on stdout, one per line; a failure sets the exit code and prints its message.
 */
async function Main(): Promise<void> {
  Logger.Info = (...args: unknown[]) => {
    process.stdout.write(`${args.map(String).join(" ")}\n`);
  };
  const url = process.env[URL_VARIABLE];
  const schemaId = process.env[SCHEMA_VARIABLE];
  if (!url || !schemaId) {
    throw new Error(`${URL_VARIABLE} and ${SCHEMA_VARIABLE} must be set`);
  }
  await Connect({ url });
  try {
    await Schemas.register(schemaId, CONTENDED);
    await WaitForIndexes(schemaId);
  } finally {
    await Disconnect();
  }
}

Main().catch((err: unknown) => {
  process.stderr.write(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
