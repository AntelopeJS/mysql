import { parentPort } from "node:worker_threads";

import { RunProbe, type WorkerMessage, type WorkerTask } from "./probe-line";

/**
 * The thread one probe runs in. It takes the task the main thread posts, runs the probe on it,
 * and posts how far the sign-in went, then the answer. Whatever `mysql2` throws outside a promise
 * ends this thread alone, and the main thread answers in its place.
 */
parentPort?.once("message", (task: WorkerTask) => {
  const port = parentPort;
  const post = (message: WorkerMessage) => port?.postMessage(message);
  void RunProbe(task.uri, task.timeoutMs, (stage) => post({ stage })).then(
    (answer) => post({ answer }),
  );
});
