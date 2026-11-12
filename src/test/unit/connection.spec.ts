import { EventEmitter } from "node:events";
import { expect } from "chai";

import {
  type BeforeDisconnect,
  GuardConnection,
  type PoolTeardown,
  RegisterBeforeDisconnect,
  SettleBeforeDisconnect,
} from "../../connection";

const POOL_END = "pool.end";

const CONNECTION_ERROR = "error";
const DROPPED = "Connection lost: The server closed the connection.";

function Recording(log: string[], name: string): BeforeDisconnect {
  return () => {
    log.push(name);
  };
}

function RecordingAfterSuspension(
  log: string[],
  name: string,
): BeforeDisconnect {
  return async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    log.push(name);
  };
}

function Throwing(log: string[], name: string): BeforeDisconnect {
  return () => {
    log.push(name);
    throw new Error(name);
  };
}

function Rejecting(log: string[], name: string): BeforeDisconnect {
  return async () => {
    log.push(name);
    throw new Error(name);
  };
}

function EndingInto(log: string[]): PoolTeardown {
  return async () => {
    log.push(POOL_END);
  };
}

async function Sweep(log: string[], callbacks: BeforeDisconnect[]) {
  const withdrawals = callbacks.map((callback) =>
    RegisterBeforeDisconnect(callback),
  );
  try {
    await SettleBeforeDisconnect(EndingInto(log));
  } finally {
    for (const withdraw of withdrawals) {
      withdraw();
    }
  }
}

/** A connection as `mysql2` builds one for its pool: a single `once("error")` listener that unpools it. */
function DriverConnection(): EventEmitter {
  const connection = new EventEmitter();
  connection.once(CONNECTION_ERROR, () => undefined);
  return connection;
}

describe("the before-disconnect registry", () => {
  it("runs a registered callback before the pool is ended", async () => {
    const log: string[] = [];
    await Sweep(log, [Recording(log, "cursors")]);
    expect(log).to.deep.equal(["cursors", POOL_END]);
  });

  it("waits for a callback that only finishes after a suspension point", async () => {
    const log: string[] = [];
    await Sweep(log, [RecordingAfterSuspension(log, "cursors")]);
    expect(log).to.deep.equal(["cursors", POOL_END]);
  });

  it("runs every registered callback, in registration order", async () => {
    const log: string[] = [];
    await Sweep(log, [
      Recording(log, "first"),
      Recording(log, "second"),
      Recording(log, "third"),
    ]);
    expect(log).to.deep.equal(["first", "second", "third", POOL_END]);
  });

  it("ends the pool anyway when a callback throws synchronously", async () => {
    const log: string[] = [];
    await Sweep(log, [Throwing(log, "broken"), Recording(log, "healthy")]);
    expect(log).to.deep.equal(["broken", "healthy", POOL_END]);
  });

  it("ends the pool anyway when a callback rejects", async () => {
    const log: string[] = [];
    await Sweep(log, [Rejecting(log, "broken"), Recording(log, "healthy")]);
    expect(log).to.deep.equal(["broken", "healthy", POOL_END]);
  });

  it("keeps registrations across a disconnect, so the next one sweeps again", async () => {
    const log: string[] = [];
    const withdraw = RegisterBeforeDisconnect(Recording(log, "cursors"));
    try {
      await SettleBeforeDisconnect(EndingInto(log));
      await SettleBeforeDisconnect(EndingInto(log));
    } finally {
      withdraw();
    }
    expect(log).to.deep.equal(["cursors", POOL_END, "cursors", POOL_END]);
  });

  it("stops running a callback whose registration was withdrawn", async () => {
    const log: string[] = [];
    RegisterBeforeDisconnect(Recording(log, "cursors"))();
    await SettleBeforeDisconnect(EndingInto(log));
    expect(log).to.deep.equal([POOL_END]);
  });

  it("ends the pool when nothing is registered", async () => {
    const log: string[] = [];
    await Sweep(log, []);
    expect(log).to.deep.equal([POOL_END]);
  });
});

describe("a pooled connection", () => {
  it("would end the process on a second error, which the driver's own listener no longer catches", () => {
    const connection = DriverConnection();
    connection.emit(CONNECTION_ERROR, new Error(DROPPED));
    expect(() =>
      connection.emit(CONNECTION_ERROR, new Error(DROPPED)),
    ).to.throw(DROPPED);
  });

  it("swallows every error once guarded", () => {
    const connection = GuardConnection(DriverConnection());
    expect(() =>
      connection.emit(CONNECTION_ERROR, new Error(DROPPED)),
    ).to.not.throw();
    expect(() =>
      connection.emit(CONNECTION_ERROR, new Error(DROPPED)),
    ).to.not.throw();
    expect(connection.listenerCount(CONNECTION_ERROR)).to.equal(1);
  });

  it("answers the connection it guarded, so it composes as the pool's listener", () => {
    const connection = new EventEmitter();
    expect(GuardConnection(connection)).to.equal(connection);
  });
});
