import { describe, expect, test } from "vitest";

import {
  createStressRun,
  defaultStressScenarios,
} from "../packages/core/src/stress.js";
import { simulateStressWorkflow } from "../services/worker/src/workflows/stress.js";

describe("stress workflow", () => {
  test("completes all steps in simulation mode", async () => {
    const scenario = defaultStressScenarios("boba")[0];
    expect(scenario).toBeDefined();
    const run = createStressRun(scenario!);

    const result = await simulateStressWorkflow(run);

    expect(result.status).toBe("completed");
    expect(result.checkpoint.completedStepIds).toHaveLength(
      scenario!.steps.length,
    );
  });
});
