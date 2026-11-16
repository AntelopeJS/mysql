/**
 * The driver the real code connects through: a `mysql2` pool whose connections are sessions of the
 * fake {@link MariaDb}. `connection.ts` builds its pool with `createPool` from `mysql2/promise`, so
 * installing this replaces that one export. A cursor's stream, which `row-stream.ts` takes from the
 * callback driver's pooled connection, is a `Readable` the engine fills as the driver does.
 */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { PoolConnection as CallbackPoolConnection } from "mysql2";

import { IsDocument } from "../../../src/implementations/database/guards";
import { type Answer, type MariaDb, ModelError, type Out, type Session } from "./engine";

interface StreamOptions {
  readonly highWaterMark: number;
}

const NEXT_TICK = () => new Promise<void>((resolve) => setImmediate(resolve));

class RowStream extends Readable {
  private queue: Out[] | undefined;
  private failure: Error | undefined;
  private isReady = false;

  constructor(
    options: StreamOptions,
    answer: () => Answer,
  ) {
    super({ objectMode: true, highWaterMark: options.highWaterMark });
    setImmediate(() => {
      const answered = answer();
      this.queue = [...answered.rows];
      this.failure = answered.error;
      this.isReady = true;
      this.pump();
    });
  }

  override _read(): void {
    this.pump();
  }

  private pump(): void {
    if (!this.isReady || this.destroyed) {
      return;
    }
    if (this.failure) {
      this.destroy(this.failure);
      return;
    }
    while (this.queue && this.queue.length > 0) {
      const row = this.queue.shift();
      if (row && !this.push(row)) {
        return;
      }
    }
    if (this.queue?.length === 0) {
      this.queue = undefined;
      this.push(null);
    }
  }
}

/** The callback driver's connection, which `row-stream.ts` checks with `instanceof` and streams from. */
function callbackConnection(engine: MariaDb, session: Session): EventEmitter {
  const connection = Reflect.construct(EventEmitter, [], CallbackPoolConnection);
  Reflect.set(connection, "execute", (text: string) => ({
    stream: (options: StreamOptions) => new RowStream(options, () => engine.run(session, text)),
  }));
  return connection;
}

/** The promise API's pooled connection over one engine session. */
export class FakeConnection {
  readonly connection: EventEmitter;

  constructor(
    private readonly engine: MariaDb,
    readonly session: Session,
    private readonly pool: FakePool,
  ) {
    this.connection = callbackConnection(engine, session);
  }

  async execute(text: string): Promise<[unknown, unknown[]]> {
    await NEXT_TICK();
    const answer = this.engine.run(this.session, text);
    if (answer.error) {
      throw answer.error;
    }
    if (/^UPDATE\b/i.test(text)) {
      return [{ affectedRows: answer.affected, warningStatus: answer.warningStatus }, []];
    }
    return [answer.rows, []];
  }

  query(text: string): Promise<[unknown, unknown[]]> {
    return this.execute(text);
  }

  release(): void {
    this.pool.release(this);
  }

  destroy(): void {
    this.pool.discard();
  }
}

/** A pool of {@link FakeConnection}s: most recently released first, a new session where none is idle, a wait where the limit is reached. */
export class FakePool extends EventEmitter {
  private readonly idle: FakeConnection[] = [];
  private readonly waiting: ((connection: FakeConnection) => void)[] = [];
  private open = 0;

  constructor(
    private readonly engine: MariaDb,
    private readonly limit: number,
  ) {
    super();
  }

  async getConnection(): Promise<FakeConnection> {
    await NEXT_TICK();
    const idle = this.idle.pop();
    if (idle) {
      return idle;
    }
    if (this.open < this.limit) {
      return this.create();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private create(): FakeConnection {
    this.open += 1;
    const connection = new FakeConnection(this.engine, this.engine.open(), this);
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
    return Promise.resolve();
  }
}

/** Makes the next `Connect` of the real code open a {@link FakePool} over `engine`, and answers how to undo that. */
export function installDriver(engine: MariaDb): () => void {
  const loaded: unknown = createRequire(__filename)("mysql2/promise");
  if (!IsDocument(loaded)) {
    throw new ModelError("mysql2/promise does not export an object");
  }
  const original = loaded.createPool;
  loaded.createPool = (options: { connectionLimit?: number }) => new FakePool(engine, options.connectionLimit ?? 10);
  return () => {
    loaded.createPool = original;
  };
}
