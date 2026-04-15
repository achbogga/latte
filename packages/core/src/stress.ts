import { randomUUID } from "node:crypto";

import type { FailureMode, StressRun, StressScenario } from "./types.js";

export function defaultStressScenarios(projectKey: string): StressScenario[] {
  return [
    {
      acceptedFailureModes: [
        "worker_crash",
        "token_expired",
        "network_partition",
      ],
      description:
        "Three-day branch drift and release triage flow that crosses GitHub, benchmarks, and docs.",
      durationHours: 72,
      id: "repo-release-gauntlet",
      projectKey,
      steps: [
        {
          checkpointKey: "compile-brief",
          endpoint: "github",
          expectedArtifacts: ["brief.json", "issue-triage.md"],
          id: "step-1",
          kind: "provider",
          prompt:
            "Compile the current repo brief and triage high-signal issues.",
        },
        {
          checkpointKey: "benchmark-refresh",
          endpoint: "storage",
          expectedArtifacts: ["benchmark-report.md"],
          id: "step-2",
          kind: "connector",
          prompt:
            "Refresh benchmark artifacts and compare them to the incumbent baseline.",
        },
        {
          checkpointKey: "draft-pr",
          endpoint: "github",
          expectedArtifacts: ["draft-pr.md"],
          id: "step-3",
          kind: "report",
          prompt: "Draft a PR summary and publish the next-run plan.",
        },
      ],
      tags: ["swe", "resume", "release"],
    },
    {
      acceptedFailureModes: [
        "duplicate_delivery",
        "rate_limit",
        "cache_corruption",
      ],
      description:
        "Ops lab run that requires memory-backed follow-up after connector failures and stale cache.",
      durationHours: 72,
      id: "ops-escalation-lab",
      projectKey,
      steps: [
        {
          checkpointKey: "ingest-alert",
          endpoint: "rest",
          expectedArtifacts: ["incident-summary.md"],
          id: "step-1",
          kind: "connector",
          prompt:
            "Ingest the alert payload and build a first-response summary.",
        },
        {
          checkpointKey: "human-review",
          endpoint: "chat",
          expectedArtifacts: ["approval-request.md"],
          id: "step-2",
          kind: "approval",
          prompt:
            "Request operator approval before the next mutation-capable step.",
        },
        {
          checkpointKey: "resume-session",
          endpoint: "provider",
          expectedArtifacts: ["resumed-session.json"],
          id: "step-3",
          kind: "provider",
          prompt:
            "Resume the interrupted session and continue with the approved plan.",
        },
      ],
      tags: ["ops", "chaos", "memory"],
    },
  ];
}

export function createStressRun(scenario: StressScenario): StressRun {
  return {
    checkpoint: {
      completedStepIds: [],
      lastUpdatedAt: new Date().toISOString(),
      runId: randomUUID(),
    },
    createdAt: new Date().toISOString(),
    failures: [],
    id: randomUUID(),
    scenario,
    status: "scheduled",
  };
}

export function advanceStressRun(
  run: StressRun,
  stepId: string,
  failure?: FailureMode,
): StressRun {
  const next = structuredClone(run);
  if (failure) {
    next.failures.push(failure);
    next.status = failure === "token_expired" ? "blocked" : "running";
    next.checkpoint.lastUpdatedAt = new Date().toISOString();
    return next;
  }

  if (!next.checkpoint.completedStepIds.includes(stepId)) {
    next.checkpoint.completedStepIds.push(stepId);
  }
  next.checkpoint.lastUpdatedAt = new Date().toISOString();
  next.status =
    next.checkpoint.completedStepIds.length === next.scenario.steps.length
      ? "completed"
      : "running";
  return next;
}
