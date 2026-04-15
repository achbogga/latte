import path from "node:path";
import { fileURLToPath } from "node:url";

import { Worker } from "@temporalio/worker";
import { defaultStressScenarios } from "@achbogga/latte-core";

import * as activities from "./activities/stress.js";

async function main(): Promise<void> {
  const taskQueue = process.env.LATTE_TEMPORAL_TASK_QUEUE ?? "latte-stress";
  const temporalAddress = process.env.TEMPORAL_ADDRESS;
  if (!temporalAddress) {
    console.log(
      JSON.stringify(
        {
          status: "standby",
          taskQueue,
          temporalAddress: null,
          scenarios: defaultStressScenarios("demo"),
        },
        null,
        2,
      ),
    );
    return;
  }

  const workflowsPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "workflows",
    "stress.js",
  );
  const worker = await Worker.create({
    activities,
    taskQueue,
    workflowsPath,
  });
  console.log(
    `Latte worker connected to ${temporalAddress} on queue ${taskQueue}`,
  );
  await worker.run();
}

void main();
