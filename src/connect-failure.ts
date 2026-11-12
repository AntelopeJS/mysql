const DEFAULT_PORT = "3306";

const UNANSWERED_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"]);

/** One sentence per driver code that a person configuring `url` can act on. */
const SENTENCES = new Map<string, string>([
  ["ER_ACCESS_DENIED_ERROR", "wrong user or password"],
  ["ER_BAD_DB_ERROR", "the database does not exist"],
  [
    "ER_DBACCESS_DENIED_ERROR",
    "the user may not use the database, or it does not exist",
  ],
  ["ER_SECURE_TRANSPORT_REQUIRED", "the server requires SSL"],
]);

function Endpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || DEFAULT_PORT}`;
  } catch {
    return "the configured host";
  }
}

function Sentence(code: string, url: string): string | undefined {
  if (UNANSWERED_CODES.has(code)) {
    return `the server is not answering at ${Endpoint(url)}`;
  }
  return SENTENCES.get(code);
}

/**
 * Words a failed first connection for the person who configured `url`, keeping the original code.
 *
 * A wrong password, a missing or forbidden database, a server that does not answer and a server
 * that requires SSL each read as one sentence; anything else keeps the driver's own message.
 */
export function DescribeConnectFailure(err: Error, url: string): string {
  const code = "code" in err ? String(err.code) : undefined;
  if (!code) {
    return err.message;
  }
  const sentence = Sentence(code, url) ?? err.message;
  return `${sentence} (${code})`;
}
