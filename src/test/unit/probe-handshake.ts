import { randomBytes } from "node:crypto";
import type net from "node:net";

import { type FakeServer, Frame, Serve } from "./probe-fixture";

const HEADER_BYTES = 4;
const MAX_LENGTH_BYTE = 251;

/** The capabilities the fake server offers: protocol 4.1, secure connection and plugin authentication. */
const CAPABILITIES =
  0x1 | 0x2 | 0x4 | 0x8 | 0x200 | 0x2000 | 0x8000 | 0x20000 | 0x80000;
/** `CLIENT_SSL`, offered by a server that takes TLS. */
export const SSL_CAPABILITY = 0x800;

const PROTOCOL_VERSION = 10;
const UTF8MB4 = 255;
const AUTOCOMMIT = 2;
const AUTH_DATA_LENGTH = 21;
const RESERVED_BYTES = 10;
const OK = 0x00;
const AUTH_SWITCH = 0xfe;
const MORE_DATA = 0x01;
/** The fixed part of a handshake response, before the user name. */
const RESPONSE_PREFIX_BYTES = 32;

/** One packet the client sent, with the sequence id it carried. */
export interface Packet {
  sequence: number;
  payload: Buffer;
}

/** What the client answered to the server's greeting. */
export interface HandshakeResponse {
  user: string;
  /** The authentication data the client derived, empty when it had no password. */
  token: Buffer;
}

/** The connection of one client to the fake server, packet by packet. */
export interface ClientLine {
  readonly scramble: Buffer;
  /** The next packet the client sends, or `undefined` once it has closed. */
  next: () => Promise<Packet | undefined>;
  send: (sequence: number, payload: Buffer) => void;
  /** Sends several packets in one write, so the client reads them in one chunk. */
  sendAll: (packets: readonly (readonly [number, Buffer])[]) => void;
  /** Every byte the client sent so far. */
  received: () => Buffer;
}

function Line(socket: net.Socket, scramble: Buffer): ClientLine {
  const chunks: Buffer[] = [];
  let pending = Buffer.alloc(0);
  let closed = false;
  let wake: (() => void) | undefined;
  socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    pending = Buffer.concat([pending, chunk]);
    wake?.();
  });
  socket.on("close", () => {
    closed = true;
    wake?.();
  });
  const take = (): Packet | undefined => {
    if (pending.length < HEADER_BYTES) {
      return undefined;
    }
    const length = pending.readUIntLE(0, 3);
    if (pending.length < HEADER_BYTES + length) {
      return undefined;
    }
    const packet = {
      sequence: pending[3],
      payload: pending.subarray(HEADER_BYTES, HEADER_BYTES + length),
    };
    pending = pending.subarray(HEADER_BYTES + length);
    return packet;
  };
  return {
    scramble,
    next: async () => {
      for (;;) {
        const packet = take();
        if (packet !== undefined || closed) {
          return packet;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
    send: (sequence, payload) => socket.write(Frame(sequence, payload)),
    sendAll: (packets) =>
      socket.write(
        Buffer.concat(
          packets.map(([sequence, payload]) => Frame(sequence, payload)),
        ),
      ),
    received: () => Buffer.concat(chunks),
  };
}

function Greeting(scramble: Buffer, plugin: string, extra: number): Buffer {
  const capabilities = CAPABILITIES | extra;
  const id = Buffer.alloc(4);
  id.writeUInt32LE(1);
  const lower = Buffer.alloc(2);
  lower.writeUInt16LE(capabilities & 0xffff);
  const status = Buffer.alloc(2);
  status.writeUInt16LE(AUTOCOMMIT);
  const upper = Buffer.alloc(2);
  upper.writeUInt16LE(capabilities >>> 16);
  return Buffer.concat([
    Buffer.from([PROTOCOL_VERSION]),
    Buffer.from("8.4.0-fake\0"),
    id,
    scramble.subarray(0, 8),
    Buffer.from([0]),
    lower,
    Buffer.from([UTF8MB4]),
    status,
    upper,
    Buffer.from([AUTH_DATA_LENGTH]),
    Buffer.alloc(RESERVED_BYTES),
    scramble.subarray(8),
    Buffer.from([0]),
    Buffer.from(`${plugin}\0`),
  ]);
}

/** Reads the user and the authentication data out of a client's handshake response. */
export function ParseResponse(payload: Buffer): HandshakeResponse {
  const end = payload.indexOf(0, RESPONSE_PREFIX_BYTES);
  const length = payload[end + 1];
  if (length >= MAX_LENGTH_BYTE) {
    throw new Error("the fake server reads tokens shorter than 251 bytes");
  }
  return {
    user: payload.subarray(RESPONSE_PREFIX_BYTES, end).toString("utf8"),
    token: payload.subarray(end + 2, end + 2 + length),
  };
}

export const OK_PACKET = Buffer.from([OK, 0, 0, AUTOCOMMIT, 0, 0, 0]);

/** A request to switch to `plugin`, with fresh authentication data. */
export function AuthSwitch(plugin: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([AUTH_SWITCH]),
    Buffer.from(`${plugin}\0`),
    data,
    Buffer.from([0]),
  ]);
}

/** More authentication data from the server, as `caching_sha2_password` sends it. */
export function MoreData(data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([MORE_DATA]), data]);
}

/**
 * A server that speaks the MySQL handshake: it greets each client as `plugin` would, then hands
 * the connection to `converse`, which plays the rest of the server's part.
 */
export function HandshakeServer(
  plugin: string,
  converse: (line: ClientLine) => Promise<void>,
  extraCapabilities = 0,
): Promise<FakeServer> {
  return Serve((socket) => {
    const scramble = Buffer.from(
      randomBytes(20).map((byte) => byte & 0x7f || 1),
    );
    const line = Line(socket, scramble);
    line.send(0, Greeting(scramble, plugin, extraCapabilities));
    converse(line).then(
      () => socket.end(),
      () => socket.destroy(),
    );
  });
}
