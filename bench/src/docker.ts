import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const READY_TRIES = 180;
const READY_PAUSE_MS = 1000;

/** Runs a command and answers its standard output; a failure throws with its standard error. */
export function Exec(command: string, args: readonly string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Starts a detached, self-removing container that publishes `port` on a free loopback port. */
export function StartContainer(
  name: string,
  image: string,
  port: number,
  env: Record<string, string>,
  args: readonly string[],
): void {
  Exec("docker", ["rm", "-f", name]);
  Exec("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    "-p",
    `127.0.0.1::${port}`,
    image,
    ...args,
  ]);
}

export function RemoveContainer(name: string): void {
  Exec("docker", ["rm", "-f", name]);
}

/** The loopback port docker published for the container's `port`. */
export function PublishedPort(name: string, port: number): number {
  const published =
    Exec("docker", ["port", name, `${port}/tcp`]).split("\n")[0] ?? "";
  const value = Number(published.slice(published.lastIndexOf(":") + 1));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} published no port for ${port}`);
  }
  return value;
}

/** Waits until `probe` stops throwing, as a server that accepts connections does. */
export async function WaitReady(
  name: string,
  probe: () => void,
): Promise<void> {
  for (let tries = 0; tries < READY_TRIES; tries++) {
    try {
      probe();
      return;
    } catch {
      await sleep(READY_PAUSE_MS);
    }
  }
  throw new Error(`${name} did not accept connections`);
}

/** The image's repository digest, which pins the exact image a run measured. */
export function ImageDigest(image: string): string {
  return Exec("docker", [
    "image",
    "inspect",
    "--format",
    "{{index .RepoDigests 0}}",
    image,
  ]).trim();
}

/** The running containers, by name and image: what else shares the machine with a measured run. */
export function RunningContainers(): string[] {
  return Exec("docker", ["ps", "--format", "{{.Names}} ({{.Image}})"])
    .split("\n")
    .filter((line) => line.length > 0);
}
