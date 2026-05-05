import { randomUUID } from "node:crypto";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildDefaultDaemonState,
  markTaskCompleted,
  markTaskRunning,
} from "./agent.js";
import { FileCronStore } from "./cron.js";
import { readJson, updateJson, writeJson } from "./fs.js";
import { JsonMemoryStore, sweepMemory } from "./memory.js";
import { resolveProjectStateRoot } from "./session.js";
import type {
  FailureMode,
  HarnessStressCheck,
  HarnessStressReport,
  ProviderName,
  StressRun,
  StressScenario,
} from "./types.js";

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

function check(
  checks: HarnessStressCheck[],
  name: string,
  passed: boolean,
  detail: string,
): void {
  checks.push({ detail, name, passed });
}

export async function runHarnessStressGauntlet(
  projectRoot: string,
  projectKey: string,
  provider: ProviderName,
): Promise<HarnessStressReport> {
  const checks: HarnessStressCheck[] = [];
  const stateRoot = resolveProjectStateRoot(projectRoot);
  const timestamp = new Date().toISOString();
  const chaosRoot = path.join(stateRoot, "stress", "chaos");

  const counterPath = path.join(chaosRoot, "counter.json");
  await Promise.all(
    Array.from({ length: 32 }, async () =>
      updateJson(counterPath, { count: 0 }, (current) => ({
        count: current.count + 1,
      })),
    ),
  );
  const counter = await readJson(counterPath, { count: 0 });
  check(
    checks,
    "durable-state-serializes-concurrent-writes",
    counter.count === 32,
    `count=${counter.count}`,
  );

  const corruptPath = path.join(chaosRoot, "corrupt-primary.json");
  await writeJson(corruptPath, { generation: 1 });
  await writeJson(corruptPath, { generation: 2 });
  await writeFile(corruptPath, "{corrupt", "utf8");
  const recovered = await readJson(corruptPath, { generation: 0 });
  check(
    checks,
    "durable-state-recovers-from-backup",
    recovered.generation === 1,
    `generation=${recovered.generation}`,
  );

  const lockedPath = path.join(chaosRoot, "stale-lock.json");
  await mkdir(`${lockedPath}.lock`, { recursive: true });
  const oldLockTime = new Date(Date.now() - 180_000);
  await utimes(`${lockedPath}.lock`, oldLockTime, oldLockTime);
  await writeJson(lockedPath, { ok: true });
  const staleLockRecovered = await readJson(lockedPath, { ok: false });
  check(
    checks,
    "durable-state-reclaims-stale-lock",
    staleLockRecovered.ok,
    `ok=${String(staleLockRecovered.ok)}`,
  );

  const memory = new JsonMemoryStore(stateRoot);
  await memory.add({
    confidence: 0.95,
    content: "Latte cron jobs must not duplicate queued isolated sessions.",
    kind: "policy",
    metadata: { gauntlet: true },
    namespace: projectKey,
    provenance: ["stress:extreme"],
  });
  await memory.add({
    confidence: 0.95,
    content: "Latte cron jobs must not duplicate queued isolated sessions.",
    kind: "policy",
    metadata: { gauntlet: true, duplicate: true },
    namespace: projectKey,
    provenance: ["stress:extreme"],
  });
  await memory.add({
    confidence: 0.2,
    content: "Expired connector token should be pruned.",
    freshnessTtlSeconds: 1,
    kind: "episodic",
    metadata: { gauntlet: true },
    namespace: projectKey,
    provenance: ["stress:extreme"],
  });
  const sweep = await sweepMemory(stateRoot, projectKey, {
    maxPromoted: 10,
    minScore: 0.2,
    now: new Date(Date.now() + 5_000),
  });
  check(
    checks,
    "memory-sweep-prunes-and-promotes",
    sweep.expired >= 1 &&
      sweep.retained < sweep.inputItems &&
      sweep.promoted >= 1,
    `input=${sweep.inputItems} retained=${sweep.retained} promoted=${sweep.promoted} expired=${sweep.expired}`,
  );

  const cron = new FileCronStore(projectRoot);
  const first = await cron.addJob({
    name: "gauntlet-isolated-a",
    prompt: "Simulate cron isolated task A",
    schedule: { at: timestamp, kind: "at" },
    sessionTarget: { kind: "isolated" },
    tags: ["gauntlet"],
  });
  const second = await cron.addJob({
    name: "gauntlet-isolated-b",
    prompt: "Simulate cron isolated task B",
    schedule: { at: timestamp, kind: "at" },
    sessionTarget: { kind: "isolated" },
    tags: ["gauntlet"],
  });
  let state = buildDefaultDaemonState(projectKey, provider);
  const tick = await cron.enqueueDueJobs(state, {
    maxConcurrentRuns: 1,
    now: new Date(timestamp),
    projectKey,
    provider,
  });
  state = tick.state;
  check(
    checks,
    "cron-enforces-concurrency",
    tick.enqueued.length === 1 && tick.skipped.length === 1,
    `enqueued=${tick.enqueued.length} skipped=${tick.skipped.length}`,
  );
  check(
    checks,
    "cron-isolated-session-key",
    tick.enqueued[0]?.sessionKey.startsWith(`cron:${first.id}`) === true ||
      tick.enqueued[0]?.sessionKey.startsWith(`cron:${second.id}`) === true,
    `sessionKey=${tick.enqueued[0]?.sessionKey ?? "missing"}`,
  );

  const task = state.tasks.find(
    (candidate) => candidate.origin?.kind === "cron",
  );
  if (task) {
    state = markTaskRunning(
      state,
      task.id,
      new Date(Date.now() + 1_000).toISOString(),
    );
    state = markTaskCompleted(
      state,
      task.id,
      new Date(Date.now() + 2_000).toISOString(),
    );
    await cron.reconcileWithAgentState(state);
  }
  const runs = await cron.listRuns();
  await cron.removeJob(first.id);
  await cron.removeJob(second.id);
  check(
    checks,
    "cron-reconciles-run-ledger",
    runs.some((run) => run.status === "succeeded") &&
      runs.some((run) => run.status === "skipped"),
    `statuses=${runs.map((run) => run.status).join(",")}`,
  );

  const passed = checks.filter((entry) => entry.passed).length;
  const report: HarnessStressReport = {
    checks,
    generatedAt: new Date().toISOString(),
    projectKey,
    scenario: "extreme-harness-gauntlet",
    summary: {
      failed: checks.length - passed,
      passed,
      total: checks.length,
    },
  };
  const reportPath = path.join(
    stateRoot,
    "stress",
    `extreme-harness-gauntlet-${randomUUID()}.json`,
  );
  await writeJson(reportPath, { ...report, reportPath });
  return { ...report, reportPath };
}
