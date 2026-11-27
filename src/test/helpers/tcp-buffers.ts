import { readFileSync } from "node:fs";

/** The files holding the largest buffer TCP autotuning grows a socket's receive and send side to. */
const TCP_BUFFER_LIMITS = [
  "/proc/sys/net/ipv4/tcp_rmem",
  "/proc/sys/net/ipv4/tcp_wmem",
];
/** Stock Linux limits, 6 MB to receive and 4 MB to send, where `/proc` cannot be read. */
const STOCK_TCP_BUFFER_BYTES = 10 * 1024 * 1024;

/** The receive and send limits of one TCP socket of this host, summed, in bytes. */
export function TcpBufferBytes(): number {
  try {
    const bytes = TCP_BUFFER_LIMITS.reduce(
      (sum, file) =>
        sum + Number(readFileSync(file, "utf8").trim().split(/\s+/)[2]),
      0,
    );
    return Number.isFinite(bytes) ? bytes : STOCK_TCP_BUFFER_BYTES;
  } catch {
    return STOCK_TCP_BUFFER_BYTES;
  }
}
