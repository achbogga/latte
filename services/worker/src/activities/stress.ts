import type { StressStep } from "@achbogga/latte-core";

export interface StepActivityResult {
  artifact: string;
  stepId: string;
}

export function runStressStep(step: StressStep): Promise<StepActivityResult> {
  return Promise.resolve({
    artifact: `${step.endpoint}:${step.expectedArtifacts[0] ?? "checkpoint.json"}`,
    stepId: step.id,
  });
}
