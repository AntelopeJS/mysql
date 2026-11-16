/**
 * The driver the real code connects through: a `mysql2` pool whose connections are sessions of the
 * fake {@link MysqlServer}. `connection.ts` builds its pool with `createPool` from `mysql2/promise`,
 * so installing this replaces that one export.
 */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

import { IsDocument } from "../../../src/implementations/database/guards";
import { LostConnection, ModelError, type MysqlServer, type Session } from "./server";

/** The promise API's pooled connection over one server session. */
export class FakeConnection {
  readonly connection = new EventEmitter();
  readonly threadId: number;
  private isDiscarded = false;

  constructor(
    private readonly server: MysqlServer,
    readonly session: Session,
    private readonly pool: FakePool,
  ) {
    this.threadId = session.id;
  }

  async execute(text: string, args: readonly unknown[] = []): Promise<[unknown, unknown[]]> {
    try {
      const answer = await this.server.run(this.session, text, args);
      return /^(?:ALTER|CREATE|INSERT|SET|KILL|DROP)\b/i.test(text)
        ? [{ affectedRows: answer.affected }, []]
        : [answer.rows, []];
    } catch (error) {
      this.server.failedOn.add(this.pool.generation);
      if (error instanceof LostConnection) {
        this.discard();
      }
      throw error;
    }
  }

  query(text: string, args: readonly unknown[] = []): Promise<[unknown, unknown[]]> {
    return this.execute(text, args);
  }

  release(): void {
    if (!this.isDiscarded) {
      this.pool.release(this);
    }
  }

  destroy(): void {
    this.server.terminate(this.session);
    this.discard();
  }

  private discard(): void {
    if (!this.isDiscarded) {
      this.isDiscarded = true;
      this.pool.discard();
    }
  }
}

/** A pool of {@link FakeConnection}s: most recently released first, a new session where none is idle, a wait where the limit is reached. */
export class FakePool extends EventEmitter {
  private readonly idle: FakeConnection[] = [];
  private readonly waiting: ((connection: FakeConnection) => void)[] = [];
  private readonly all = new Set<FakeConnection>();
  private open = 0;
  isEnded = false;
  readonly generation: number;

  constructor(
    private readonly server: MysqlServer,
    private readonly limit: number,
  ) {
    super();
    server.pools += 1;
    this.generation = server.pools;
  }

  getConnection(): Promise<FakeConnection> {
    if (this.isEnded) {
      return Promise.reject(new ModelError("the pool was ended and still asked for a connection"));
    }
    const idle = this.idle.pop();
    if (idle) {
      return Promise.resolve(idle);
    }
    if (this.open < this.limit) {
      return Promise.resolve(this.create());
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private create(): FakeConnection {
    this.open += 1;
    const connection = new FakeConnection(this.server, this.server.open(), this);
    this.all.add(connection);
    this.emit("connection", connection.connection);
    return connection;
  }

  release(connection: FakeConnection): void {
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter(connection);
    } else {
      this.idle.push(connection);
    }
  }

  discard(): void {
    this.open -= 1;
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter(this.create());
    }
  }

  end(): Promise<void> {
    this.isEnded = true;
    for (const connection of this.all) {
      this.server.close(connection.session);
    }
    return Promise.resolve();
  }
}

/** Makes the next `Connect` of the real code open a {@link FakePool} over `server`, and answers how to undo that. */
export function installDriver(server: MysqlServer): () => void {
  const loaded: unknown = createRequire(__filename)("mysql2/promise");
  if (!IsDocument(loaded)) {
    throw new ModelError("mysql2/promise does not export an object");
  }
  const original = loaded.createPool;
  loaded.createPool = (options: { connectionLimit?: number }) => new FakePool(server, options.connectionLimit ?? 10);
  return () => {
    loaded.createPool = original;
  };
}
