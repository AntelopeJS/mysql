import net from "node:net";

import { IsString } from "./implementations/database/guards";

/**
 * What the probe does with an option of a URL's query, which `mysql2` reads over any option the
 * probe passes falsy. `keep` passes it on, once its value has the shape the probe checks. `override`
 * takes it out, so the probe's own value or the driver's default holds. `refuse` answers `refused`
 * before the probe connects.
 */
export type UrlOptionUse = "keep" | "override" | "refuse";

const KEPT = "keep";
const OVERRIDDEN = "override";
const REFUSED = "refuse";

/**
 * Every option `mysql2` takes, with what the probe does when a URL's query sets it. The probe keeps
 * only what changes how the connection is made: the socket path, the local address and TLS. It
 * takes out what only tunes the driver, the transport or a pool, since a check of the connection
 * needs none of it and each kept option is a way into code no check runs. It refuses hooks and
 * credentials beside the URL's user and password. The host, the port, the user, the password and
 * the database come from the URL's authority, and `mysql2` ignores them in its query. An option the
 * table does not name is refused.
 */
export const URL_OPTIONS: ReadonlyMap<string, UrlOptionUse> = new Map([
  ["socketPath", KEPT],
  ["localAddress", KEPT],
  ["ssl", KEPT],
  ["host", KEPT],
  ["port", KEPT],
  ["user", KEPT],
  ["password", KEPT],
  ["database", KEPT],
  ["compress", OVERRIDDEN],
  ["connectAttributes", OVERRIDDEN],
  ["enableKeepAlive", OVERRIDDEN],
  ["keepAliveInitialDelay", OVERRIDDEN],
  ["disableEval", OVERRIDDEN],
  ["stringifyObjects", OVERRIDDEN],
  ["trace", OVERRIDDEN],
  ["pool", OVERRIDDEN],
  ["connectionLimit", OVERRIDDEN],
  ["maxIdle", OVERRIDDEN],
  ["idleTimeout", OVERRIDDEN],
  ["queueLimit", OVERRIDDEN],
  ["waitForConnections", OVERRIDDEN],
  ["gracefulEnd", OVERRIDDEN],
  ["bigNumberStrings", OVERRIDDEN],
  ["charset", OVERRIDDEN],
  ["charsetNumber", OVERRIDDEN],
  ["connectTimeout", OVERRIDDEN],
  ["dateStrings", OVERRIDDEN],
  ["decimalNumbers", OVERRIDDEN],
  ["enableCleartextPlugin", OVERRIDDEN],
  ["flags", OVERRIDDEN],
  ["jsonStrings", OVERRIDDEN],
  ["maxPreparedStatements", OVERRIDDEN],
  ["multipleStatements", OVERRIDDEN],
  ["namedPlaceholders", OVERRIDDEN],
  ["nestTables", OVERRIDDEN],
  ["resetOnRelease", OVERRIDDEN],
  ["rowsAsArray", OVERRIDDEN],
  ["stream", OVERRIDDEN],
  ["supportBigNumbers", OVERRIDDEN],
  ["timezone", OVERRIDDEN],
  ["typeCast", OVERRIDDEN],
  ["uri", OVERRIDDEN],
  ["authPlugins", REFUSED],
  ["authSwitchHandler", REFUSED],
  ["debug", REFUSED],
  ["infileStreamFactory", REFUSED],
  ["insecureAuth", REFUSED],
  ["isServer", REFUSED],
  ["password1", REFUSED],
  ["password2", REFUSED],
  ["password3", REFUSED],
  ["passwordSha1", REFUSED],
  ["Promise", REFUSED],
  ["queryFormat", REFUSED],
]);

function IsObject(value: unknown): value is object {
  return value instanceof Object;
}

/** The TLS options of a URL's `ssl` object that take a boolean: whether and how the server's certificate is checked. */
const SSL_SWITCHES: ReadonlySet<string> = new Set([
  "rejectUnauthorized",
  "verifyIdentity",
]);

/** The TLS options of a URL's `ssl` object that take text: the protocol versions and the ciphers. */
const SSL_TEXTS: ReadonlySet<string> = new Set([
  "minVersion",
  "maxVersion",
  "ciphers",
]);

/** The TLS option of a URL's `ssl` object that takes trust anchors, as PEM text or a list of them. */
const SSL_ANCHORS = "ca";

/**
 * Whether the probe passes a kept option on, its value read as `mysql2` reads it: as JSON when it
 * parses as JSON, else as the text it is. A socket path is text, and a local address an IP
 * address. `ssl` is either the name of one of `mysql2`'s TLS profiles, except a name every object
 * inherits, such as `__proto__`, on which `mysql2` would write `rejectUnauthorized` over
 * `Object.prototype`; or an object of {@link SSL_SWITCHES}, {@link SSL_TEXTS} and
 * {@link SSL_ANCHORS} only. Any other TLS option is refused, a client certificate (`cert`, `key`,
 * `pfx`, `passphrase`) among them, as a credential beside the URL's user and password.
 */
function IsKept(option: string, value: string): boolean {
  let read: unknown = value;
  try {
    read = JSON.parse(value);
  } catch {
    read = value;
  }
  if (option === "socketPath") {
    return IsString(read);
  }
  if (option === "localAddress") {
    return IsString(read) && net.isIP(read) !== 0;
  }
  if (option !== "ssl") {
    return true;
  }
  if (IsString(read)) {
    return !Object.hasOwn(Object.prototype, read);
  }
  if (!IsObject(read) || Array.isArray(read)) {
    return false;
  }
  return Object.keys(read).every((key) => {
    const field: unknown = Object.getOwnPropertyDescriptor(read, key)?.value;
    if (key === SSL_ANCHORS) {
      return IsString(field) || (Array.isArray(field) && field.every(IsString));
    }
    if (SSL_SWITCHES.has(key)) {
      return field === true || field === false;
    }
    return SSL_TEXTS.has(key) && IsString(field);
  });
}

/** The URL the probe connects with, or the first option of its query that the probe refuses. */
export type ProbeTarget = { uri: string } | { refused: string };

/** Sorts a URL's query options by {@link URL_OPTIONS}; throws on a URL that does not parse. */
export function ProbeTarget(url: string): ProbeTarget {
  const parsed = new URL(url);
  for (const option of new Set(parsed.searchParams.keys())) {
    const use = URL_OPTIONS.get(option) ?? REFUSED;
    const values = parsed.searchParams.getAll(option);
    if (
      use === REFUSED ||
      (use === KEPT && !values.every((value) => IsKept(option, value)))
    ) {
      return { refused: option };
    }
    if (use === OVERRIDDEN) {
      parsed.searchParams.delete(option);
    }
  }
  return { uri: parsed.toString() };
}
