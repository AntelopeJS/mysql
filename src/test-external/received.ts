import type { ResultValue } from "@antelopejs/interface-database-catalog/testing";
import {
  IsBoolean,
  IsDocument,
  IsNumber,
  IsString,
} from "../implementations/database/guards";
import { Connection, PoolConnection } from "mysql2/promise";

/** Whether a parsed JSON value is one `ResultValue` spells, every nested element checked. */
function IsResultValue(value: unknown): value is ResultValue {
  if (
    value === null ||
    IsString(value) ||
    IsNumber(value) ||
    IsBoolean(value)
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(IsResultValue);
  }
  return IsDocument(value) && Object.values(value).every(IsResultValue);
}

function ParseResult(json: string): ResultValue {
  const parsed: unknown = JSON.parse(json);
  if (!IsResultValue(parsed)) {
    throw new TypeError("A result set holds a value JSON cannot spell");
  }
  return parsed;
}

/**
 * Every result set the module's pooled connections receive while `work` runs, as JSON: each
 * statement they run goes through the `execute` or `query` mysql2's promise `PoolConnection`
 * inherits from its `Connection`, which a method of its own shadows for the while.
 */
export async function Received<T>(
  work: () => Promise<T>,
): Promise<{ answer: T; results: string; sets: ResultValue[] }> {
  const results: string[] = [];
  const sets: ResultValue[] = [];
  const tapped = PoolConnection.prototype;
  Object.defineProperty(tapped, "execute", {
    configurable: true,
    async value(this: Connection, ...args: Parameters<Connection["execute"]>) {
      const answer = await Connection.prototype.execute.call(this, ...args);
      const json = JSON.stringify(answer[0]);
      results.push(json);
      sets.push(ParseResult(json));
      return answer;
    },
  });
  Object.defineProperty(tapped, "query", {
    configurable: true,
    async value(this: Connection, ...args: Parameters<Connection["query"]>) {
      const answer = await Connection.prototype.query.call(this, ...args);
      const json = JSON.stringify(answer[0]);
      results.push(json);
      sets.push(ParseResult(json));
      return answer;
    },
  });
  try {
    return { answer: await work(), results: results.join("\n"), sets };
  } finally {
    Reflect.deleteProperty(tapped, "execute");
    Reflect.deleteProperty(tapped, "query");
  }
}
