import diagnosticsChannel from "node:diagnostics_channel";
import { randomBytes } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { IsString } from "../../implementations/database/guards";

/** How long a probe in these tests waits to connect and for each answer. */
export const TIMEOUT_MS = 1000;

/** How long a test lets sockets settle before it counts the ones still open. */
export const CLOSE_SETTLE_MS = 1000;

const SETTLE_POLL_MS = 20;

/** A signal nobody aborts. */
export function Unaborted(): AbortSignal {
  return new AbortController().signal;
}

function PortOf(server: net.Server): number {
  const address = server.address();
  if (address === null || IsString(address)) {
    throw new Error("the server listens on no TCP port");
  }
  return address.port;
}

async function Listen(server: net.Server, where?: string): Promise<void> {
  await new Promise<void>((resolve) => {
    if (where === undefined) {
      server.listen(0, "127.0.0.1", resolve);
    } else {
      server.listen(where, resolve);
    }
  });
}

async function Settled(count: () => number, settleMs: number) {
  const until = Date.now() + settleMs;
  while (count() > 0 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
  return count();
}

/** A local port nothing listens on. */
export async function ClosedPort(): Promise<number> {
  const server = net.createServer();
  await Listen(server);
  const port = PortOf(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A local socket path for {@link RefusingServer}: a named pipe on Windows, a file in the temp directory elsewhere. */
export function LocalSocketPath(): string {
  const name = `ajs-mysql-probe-${randomBytes(6).toString("hex")}`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${name}`
    : path.join(os.tmpdir(), `${name}.sock`);
}

/** A server the tests start, and the client connections it holds. */
export interface FakeServer {
  port: number;
  /** How many connections it has accepted. */
  accepted: () => number;
  /** The connections still open once none has closed for a moment, or after `settleMs`. */
  openAfter: (settleMs: number) => Promise<number>;
  close: () => Promise<void>;
}

/** A local server that hands each connection to `greet`, on `where` when given, else on a local TCP port. */
export async function Serve(
  greet: (socket: net.Socket) => void,
  where?: string,
  allowHalfOpen = false,
): Promise<FakeServer> {
  const sockets = new Set<net.Socket>();
  let accepted = 0;
  const server = net.createServer({ allowHalfOpen }, (socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    greet(socket);
  });
  await Listen(server, where);
  return {
    port: where === undefined ? PortOf(server) : 0,
    accepted: () => accepted,
    openAfter: (settleMs) => Settled(() => sockets.size, settleMs),
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A server that accepts connections and never says a word, as a host behind a dropped packet does. */
export function SilentServer(): Promise<FakeServer> {
  return Serve(() => undefined);
}

const ERROR_PACKET = 0xff;
const HEADER_BYTES = 4;

/**
 * A server that answers each connection with an error packet in place of its greeting, as MySQL
 * does for a client host it does not accept, or once it has too many connections. On `where`
 * when given, a socket path, else on a local TCP port.
 */
export function RefusingServer(
  errno: number,
  message: string,
  where?: string,
): Promise<FakeServer> {
  return Serve((socket) => {
    socket.end(ErrorPacket(0, errno, message));
  }, where);
}

/** The payload of an error packet: what a server answers a client it refuses. */
export function ErrorPayload(
  errno: number,
  message: string,
  sqlState?: string,
): Buffer {
  return Buffer.concat([
    Buffer.from([ERROR_PACKET, errno & 0xff, errno >> 8]),
    Buffer.from(sqlState === undefined ? "" : `#${sqlState}`, "ascii"),
    Buffer.from(message, "utf8"),
  ]);
}

/**
 * An error packet with sequence id `sequence`. A server answers a command with one that carries a
 * SQL state after a `#`, and refuses a connection with one that carries none.
 */
function ErrorPacket(
  sequence: number,
  errno: number,
  message: string,
  sqlState?: string,
): Buffer {
  return Frame(sequence, ErrorPayload(errno, message, sqlState));
}

/** A packet of the MySQL protocol: its length, its sequence id and its payload. */
export function Frame(sequence: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUIntLE(payload.length, 0, 3);
  header[SEQUENCE_BYTE] = sequence;
  return Buffer.concat([header, payload]);
}

/**
 * What a relay asks of each chunk of one connection, from the client or from the server: `true`
 * once the connection has gone quiet, from this chunk on.
 */
export type Stall = (chunk: Buffer, fromClient: boolean) => boolean;

/** The byte after a packet's three-byte length: its sequence id, `0` for a command. */
const SEQUENCE_BYTE = 3;
/** The byte that names a command. */
const COMMAND_BYTE = 4;
/** COM_QUIT, which a client sends before it closes. */
export const QUIT_COMMAND = 0x01;
/** COM_STMT_PREPARE, which every statement of the probe starts with. */
export const PREPARE_COMMAND = 0x16;
/** COM_QUERY, which the probe's session pin is sent as. */
export const QUERY_COMMAND = 0x03;
/** COM_STMT_EXECUTE, which runs a statement the probe prepared. */
export const EXECUTE_COMMAND = 0x17;

/** Whether a chunk from the client starts the command `command`. */
export function Commands(command: number): Stall {
  return (chunk, fromClient) =>
    fromClient && chunk[SEQUENCE_BYTE] === 0 && chunk[COMMAND_BYTE] === command;
}

/** The reply a relay sends a client chunk in place of the server's, if any. */
export type Answer = (chunk: Buffer) => Buffer | undefined;

/** A relay's {@link Answer} that counts packets, and the count so far. */
export interface CommandCount {
  answer: Answer;
  count: () => number;
}

/** Counts the `command` packets a client sends through a relay, however its chunks split them. */
export function CommandCounter(command: number): CommandCount {
  let pending = Buffer.alloc(0);
  let count = 0;
  return {
    answer: (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= HEADER_BYTES) {
        const end = HEADER_BYTES + pending.readUIntLE(0, 3);
        if (pending.length < end) {
          break;
        }
        count += Commands(command)(pending.subarray(0, end), true) ? 1 : 0;
        pending = pending.subarray(end);
      }
      return undefined;
    },
    count: () => count,
  };
}

/** Answers the `nth` statement a client prepares with the server error `errno`, as a server refusing it would. */
export function RefuseNthPrepare(
  nth: number,
  errno: number,
  message: string,
): Answer {
  const isNth = NthCommand(PREPARE_COMMAND, nth);
  return (chunk) =>
    isNth(chunk, true) ? ErrorPacket(1, errno, message, "42000") : undefined;
}

/** Whether a client chunk starts the `nth` `command` the client sends on its connection. */
export function NthCommand(command: number, nth: number): Stall {
  const isCommand = Commands(command);
  let sent = 0;
  return (chunk, fromClient) => {
    if (!isCommand(chunk, fromClient)) {
      return false;
    }
    sent += 1;
    return sent === nth;
  };
}

interface RelayBehaviour {
  /** Once it answers `true`, the connection forwards nothing more and closes nothing, as a server does when it hangs. */
  stall?: Stall;
  /** A client that ends its side stalls the connection too, as a server does that ignores a client leaving. */
  ignoresGoodbye?: boolean;
  /** Replies to a client chunk in place of the server, which never sees it. */
  answer?: Answer;
  /** Once it answers `true` of a client chunk, the relay drops the connection, as a server that crashes does. */
  cut?: Stall;
  /** How long each chunk from the server waits before the relay passes it on, as a distant server's do. */
  delayMs?: number;
}

/** Forwards each connection to the server on `host:port`, behaving as `behaviour` says. */
export async function Relay(
  host: string,
  port: number,
  {
    stall = () => false,
    ignoresGoodbye = false,
    answer = () => undefined,
    cut = () => false,
    delayMs = 0,
  }: RelayBehaviour = {},
): Promise<FakeServer> {
  const upstreams = new Set<net.Socket>();
  const relay = await Serve(
    (client) => {
      const upstream = net.connect(port, host);
      upstreams.add(upstream);
      let stalled = false;
      if (ignoresGoodbye) {
        client.on("end", () => {
          stalled = true;
        });
      }
      const forward = (chunk: Buffer, fromClient: boolean) => {
        stalled ||= stall(chunk, fromClient);
        if (!stalled) {
          (fromClient ? upstream : client).write(chunk);
        }
      };
      client.on("data", (data) => {
        const chunk = Buffer.from(data);
        if (cut(chunk, true)) {
          client.destroy();
          return;
        }
        const reply = answer(chunk);
        if (reply === undefined) {
          forward(chunk, true);
        } else {
          client.write(reply);
        }
      });
      upstream.on("data", (chunk) => {
        if (delayMs === 0) {
          forward(Buffer.from(chunk), false);
        } else {
          setTimeout(forward, delayMs, Buffer.from(chunk), false);
        }
      });
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => {
        upstreams.delete(upstream);
        if (!stalled) {
          client.destroy();
        }
      });
      upstream.on("error", () => undefined);
    },
    undefined,
    ignoresGoodbye,
  );
  return {
    ...relay,
    close: async () => {
      for (const upstream of upstreams) {
        upstream.destroy();
      }
      await relay.close();
    },
  };
}

/** The client sockets this process opens to one port, whichever library opens them. */
export interface ClientSockets {
  /** How many of them are not destroyed once all have been, or after `settleMs`. */
  leftOpenAfter: (settleMs: number) => Promise<number>;
  stop: () => void;
}

/** Whether a `net.client.socket` message carries the socket it announces. */
function IsSocketMessage(message: unknown): message is { socket: net.Socket } {
  return (
    message instanceof Object &&
    Object.hasOwn(message, "socket") &&
    "socket" in message &&
    message.socket instanceof net.Socket
  );
}

/** Watches the client sockets this process opens to `port` from now on. */
export function WatchClientSockets(port: number): ClientSockets {
  const sockets = new Set<net.Socket>();
  const track: diagnosticsChannel.ChannelListener = (message) => {
    if (!IsSocketMessage(message)) {
      return;
    }
    const socket = message.socket;
    socket.once("connect", () => {
      if (socket.remotePort === port) {
        sockets.add(socket);
      }
    });
  };
  diagnosticsChannel.subscribe("net.client.socket", track);
  return {
    leftOpenAfter: (settleMs) =>
      Settled(
        () => [...sockets].filter((socket) => !socket.destroyed).length,
        settleMs,
      ),
    stop: () => diagnosticsChannel.unsubscribe("net.client.socket", track),
  };
}
