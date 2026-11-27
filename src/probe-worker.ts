import { parentPort } from "node:worker_threads";

import { RunProbe, type WorkerMessage, type WorkerTask } from "./probe-line";

parentPort?.once("message", (task: WorkerTask) => {
  const port = parentPort;
  const post = (message: WorkerMessage) => port?.postMessage(message);
  void RunProbe(task.uri, task.timeoutMs, (stage) => post({ stage })).then(
    (answer) => post({ answer }),
  );
});
