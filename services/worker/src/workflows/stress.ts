import { proxyActivities } from "@temporalio/workflow";
import { advanceStressRun, type StressRun } from "@achbogga/latte-core";

import type { StepActivityResult } from "../activities/stress.js";

const { runStressStep } = proxyActivities<{
  runStressStep(
    step: StressRun["scenario"]["steps"][number],
  ): Promise<StepActivityResult>;
}>({
  retry: {
    initialInterval: "5s",
    maximumAttempts: 5,
  },
  startToCloseTimeout: "5 minutes",
});

export async function stressWorkflow(
  initialRun: StressRun,
): Promise<StressRun> {
  let run = initialRun;
  for (const step of initialRun.scenario.steps) {
    await runStressStep(step);
    run = advanceStressRun(run, step.id);
  }
  return run;
}

export function simulateStressWorkflow(
  initialRun: StressRun,
): Promise<StressRun> {
  let run = initialRun;
  for (const step of initialRun.scenario.steps) {
    run = advanceStressRun(run, step.id);
  }
  return Promise.resolve(run);
}
