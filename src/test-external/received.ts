import { Connection, PoolConnection } from "mysql2/promise";

/**
 * Every result set the module's pooled connections receive while `work` runs, as JSON: each
 * statement they run goes through the `execute` or `query` mysql2's promise `PoolConnection`
 * inherits from its `Connection`, which a method of its own shadows for the while.
 */
export async function Received<T>(
  work: () => Promise<T>,
): Promise<{ answer: T; results: string }> {
  const results: string[] = [];
  const tapped = PoolConnection.prototype;
  Object.defineProperty(tapped, "execute", {
    configurable: true,
    async value(this: Connection, ...args: Parameters<Connection["execute"]>) {
      const answer = await Connection.prototype.execute.call(this, ...args);
      results.push(JSON.stringify(answer[0]));
      return answer;
    },
  });
  Object.defineProperty(tapped, "query", {
    configurable: true,
    async value(this: Connection, ...args: Parameters<Connection["query"]>) {
      const answer = await Connection.prototype.query.call(this, ...args);
      results.push(JSON.stringify(answer[0]));
      return answer;
    },
  });
  try {
    return { answer: await work(), results: results.join("\n") };
  } finally {
    Reflect.deleteProperty(tapped, "execute");
    Reflect.deleteProperty(tapped, "query");
  }
}
