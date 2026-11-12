import path from "node:path";
import { spawn } from "node:child_process";

import { GetOptions } from "../config";
import {
  type DefinitionName,
  DEFINITION_VARIABLE,
  SCHEMA_VARIABLE,
  URL_VARIABLE,
} from "./contention-schema";

/** How a registering process ended, and the information lines it logged. */
export interface Exit {
  readonly code: number | null;
  readonly stderr: string;
  readonly logged: readonly string[];
}

const REGISTERING_PROCESS = path.join(__dirname, "register-process.js");

/** Registers `definition` as `schemaId` from another process, with a module instance of its own. */
export function RegisterElsewhere(
  schemaId: string,
  definition: DefinitionName = "contended",
): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [REGISTERING_PROCESS], {
      env: {
        ...process.env,
        [URL_VARIABLE]: GetOptions().url,
        [SCHEMA_VARIABLE]: schemaId,
        [DEFINITION_VARIABLE]: definition,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr, logged: stdout.split("\n").filter(Boolean) });
    });
  });
}
