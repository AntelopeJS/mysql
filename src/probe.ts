import path from "node:path";
import { Worker } from "node:worker_threads";
import type {
  Probe,
  ProbeAnswer,
} from "@antelopejs/interface-database-catalog";

import {
  Failed,
  type Stage,
  type WorkerMessage,
  type WorkerTask,
} from "./probe-line";
import { ProbeTarget } from "./probe-options";

const WORKER = path.join(__dirname, "probe-worker.js");

const ABORTED = "The probe was aborted.";

/** What the probe answers when its worker ended without an answer or an error. */
const ENDED = "the probe ended without an answer";

/** What a probe answers once its signal has aborted. */
function Aborted(): ProbeAnswer {
  return { outcome: "unreachable", message: ABORTED };
}

/**
 * Runs a probe's task in a worker of its own and answers what the worker answers. A host that
 * forbids worker threads answers the reason as no server answered. A worker that fails before it
 * answers, which is `mysql2` throwing outside any promise, is answered as the failure it is at the
 * stage the sign-in had reached. When `signal` aborts first, the answer is
 * {@link Aborted} at once and the worker, with every socket it opened, is ended.
 */
function InWorker(
  task: WorkerTask,
  passwordGiven: boolean,
  signal: AbortSignal,
): Promise<ProbeAnswer> {
  let worker: Worker;
  try {
    worker = new Worker(WORKER);
  } catch (error) {
    return Promise.resolve(
      Failed(
        error instanceof Error ? error : new Error(String(error)),
        passwordGiven,
        "connecting",
      ),
    );
  }
  return new Promise((resolve) => {
    let stage: Stage = "connecting";
    worker.unref();
    const settle = (answer: ProbeAnswer) => {
      signal.removeEventListener("abort", abort);
      resolve(answer);
    };
    function abort() {
      settle(Aborted());
      void worker.terminate();
    }
    signal.addEventListener("abort", abort, { once: true });
    worker.on("message", (message: WorkerMessage) => {
      if ("stage" in message) {
        stage = message.stage;
      } else {
        settle(message.answer);
      }
    });
    worker.on("error", (error) => settle(Failed(error, passwordGiven, stage)));
    worker.on("exit", () => settle({ outcome: "unreachable", message: ENDED }));
    worker.postMessage(task);
  });
}

/**
 * Signs in to the MySQL or MariaDB server of a `mysql://` URL and answers what the account may do
 * with the relations of the URL's database, deciding each relation as the catalog does. It runs
 * no statement that writes, and never rejects: the driver runs in a worker thread of the probe's
 * own, so nothing a server sends can end the calling process. It closes its connection once it
 * has answered; on an answer of no server it shuts the socket at once. A URL option it does not
 * take answers `refused` before it connects. When `signal` aborts before it has settled, or has
 * aborted already, it shuts every socket it opened, opening none in the second case, and answers
 * {@link Aborted} at once, whatever the server answered so far.
 */
export const probe: Probe = async ({ url, timeoutMs, signal }) => {
  if (signal.aborted) {
    return Aborted();
  }
  let uri: string;
  let passwordGiven: boolean;
  try {
    const target = ProbeTarget(url);
    if ("refused" in target) {
      return {
        outcome: "refused",
        refusal: "other",
        message: `The probe does not take the URL option ${target.refused}.`,
      };
    }
    uri = target.uri;
    passwordGiven = decodeURIComponent(new URL(uri).password) !== "";
  } catch (error) {
    return Failed(
      error instanceof Error ? error : new Error(String(error)),
      true,
      "connecting",
    );
  }
  return InWorker({ uri, timeoutMs }, passwordGiven, signal);
};
