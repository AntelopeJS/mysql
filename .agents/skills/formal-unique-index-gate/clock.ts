/**
 * Virtual time. The convergence code pauses with `setTimeout` of `node:timers/promises` between
 * its attempts, for seconds and up to minutes; installing this replaces that one export, so the
 * check advances the clock to the next pause once nothing else can run.
 */
import { createRequire } from "node:module";

import { IsDocument } from "../../../src/implementations/database/guards";

interface Timer {
  readonly at: number;
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
  readonly signal: AbortSignal | undefined;
}

class Aborted extends Error {
  readonly code = "ABORT_ERR";
  constructor() {
    super("The operation was aborted");
    this.name = "AbortError";
  }
}

export class VirtualClock {
  now = 0;
  private timers: Timer[] = [];

  /** `delay` of `node:timers/promises`, in virtual milliseconds. */
  readonly delay = (ms: number, _value?: undefined, options?: { signal?: AbortSignal }): Promise<void> => {
    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.reject(new Aborted());
    }
    return new Promise((resolve, reject) => {
      const timer: Timer = { at: this.now + ms, resolve, reject, signal };
      this.timers.push(timer);
      signal?.addEventListener(
        "abort",
        () => {
          this.timers = this.timers.filter((pending) => pending !== timer);
          reject(new Aborted());
        },
        { once: true },
      );
    });
  };

  /** Whether a pause is waiting. */
  hasPending(): boolean {
    return this.timers.length > 0;
  }

  /** Moves to the earliest pause and ends it. */
  advance(): void {
    const [next] = [...this.timers].sort((left, right) => left.at - right.at);
    if (!next) {
      return;
    }
    this.timers = this.timers.filter((pending) => pending !== next);
    this.now = Math.max(this.now, next.at);
    next.resolve();
  }
}

/** Replaces the `setTimeout` of `node:timers/promises` with `clock`'s, and answers how to put it back. */
export function installClock(clock: VirtualClock): () => void {
  const loaded: unknown = createRequire(__filename)("node:timers/promises");
  if (!IsDocument(loaded)) {
    throw new Error("node:timers/promises does not export an object");
  }
  const original = loaded.setTimeout;
  loaded.setTimeout = clock.delay;
  return () => {
    loaded.setTimeout = original;
  };
}
