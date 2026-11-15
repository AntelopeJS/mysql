import { IsString } from "./implementations/database/guards";

/**
 * What the probe does with an option of a URL's query, which `mysql2` reads over any option the
 * probe passes. `keep` passes it on. `override` takes it out, so the probe's own value or the
 * driver's default holds. `refuse` answers `refused` before the probe connects.
 */
export type UrlOptionUse = "keep" | "override" | "refuse";

const SSL = "ssl";

/**
 * Every option `mysql2` takes, with what the probe does when a URL's query sets it. The host, the
 * port, the user, the password and the database come from the URL's authority, and `mysql2`
 * ignores them in its query. An option the table does not name is refused.
 */
export const URL_OPTIONS: ReadonlyMap<string, UrlOptionUse> = new Map([
  ["socketPath", "keep"],
  [SSL, "keep"],
  ["compress", "keep"],
  ["connectAttributes", "keep"],
  ["enableKeepAlive", "keep"],
  ["keepAliveInitialDelay", "keep"],
  ["localAddress", "keep"],
  ["disableEval", "keep"],
  ["stringifyObjects", "keep"],
  ["trace", "keep"],
  ["host", "keep"],
  ["port", "keep"],
  ["user", "keep"],
  ["password", "keep"],
  ["database", "keep"],
  ["pool", "keep"],
  ["connectionLimit", "keep"],
  ["maxIdle", "keep"],
  ["idleTimeout", "keep"],
  ["queueLimit", "keep"],
  ["waitForConnections", "keep"],
  ["gracefulEnd", "keep"],
  ["bigNumberStrings", "override"],
  ["charset", "override"],
  ["charsetNumber", "override"],
  ["connectTimeout", "override"],
  ["dateStrings", "override"],
  ["decimalNumbers", "override"],
  ["enableCleartextPlugin", "override"],
  ["flags", "override"],
  ["jsonStrings", "override"],
  ["maxPreparedStatements", "override"],
  ["multipleStatements", "override"],
  ["namedPlaceholders", "override"],
  ["nestTables", "override"],
  ["resetOnRelease", "override"],
  ["rowsAsArray", "override"],
  ["stream", "override"],
  ["supportBigNumbers", "override"],
  ["timezone", "override"],
  ["typeCast", "override"],
  ["uri", "override"],
  ["authPlugins", "refuse"],
  ["authSwitchHandler", "refuse"],
  ["debug", "refuse"],
  ["infileStreamFactory", "refuse"],
  ["insecureAuth", "refuse"],
  ["isServer", "refuse"],
  ["password1", "refuse"],
  ["password2", "refuse"],
  ["password3", "refuse"],
  ["passwordSha1", "refuse"],
  ["Promise", "refuse"],
  ["queryFormat", "refuse"],
]);

function IsObject(value: unknown): value is object {
  return value instanceof Object;
}

/** The TLS options that present a client certificate, a credential beside the URL's user and password. */
const CLIENT_CERTIFICATE = ["cert", "key", "pfx", "passphrase"];

/**
 * Whether the probe refuses a URL's `ssl` value, read as `mysql2` reads it: as JSON when it parses
 * as JSON, else as the text it is. `mysql2` looks a string up by name among its TLS
 * profiles and writes `rejectUnauthorized` onto what it found, which is `Object.prototype` for a
 * name every object inherits, such as `__proto__`. An object goes to TLS as it is, so one that
 * presents a client certificate would sign in with more than the URL's user and password.
 */
function IsRefusedSsl(value: string): boolean {
  let read: unknown = value;
  try {
    read = JSON.parse(value);
  } catch {
    read = value;
  }
  if (IsString(read)) {
    return read in Object.prototype;
  }
  return (
    IsObject(read) &&
    CLIENT_CERTIFICATE.some((option) => Object.hasOwn(read, option))
  );
}

/** The URL the probe connects with, or the first option of its query that the probe refuses. */
export type ProbeTarget = { uri: string } | { refused: string };

/** Sorts a URL's query options by {@link URL_OPTIONS}; throws on a URL that does not parse. */
export function ProbeTarget(url: string): ProbeTarget {
  const parsed = new URL(url);
  for (const option of new Set(parsed.searchParams.keys())) {
    const use = URL_OPTIONS.get(option) ?? "refuse";
    if (
      use === "refuse" ||
      (option === SSL && parsed.searchParams.getAll(option).some(IsRefusedSsl))
    ) {
      return { refused: option };
    }
    if (use === "override") {
      parsed.searchParams.delete(option);
    }
  }
  return { uri: parsed.toString() };
}
