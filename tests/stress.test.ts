import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createStressRun,
  defaultStressScenarios,
  runHarnessStressGauntlet,
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

  test("passes the extreme harness gauntlet", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "latte-extreme-"));

    const report = await runHarnessStressGauntlet(
      projectRoot,
      "latte-extreme",
      "codex",
    );

    expect(report.summary.failed).toBe(0);
    expect(report.checks.map((entry) => entry.name)).toContain(
      "cron-enforces-concurrency",
    );
  });
});
