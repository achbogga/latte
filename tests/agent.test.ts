import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  applyAgentCommand,
  assessAgentResources,
  buildDefaultDaemonState,
  buildDefaultResourcePolicy,
  createAgentCommand,
  detectTransientFailureSignature,
  FileAgentStore,
  markTaskRetry,
  markTaskRunning,
  selectRunnableTask,
} from "../packages/core/src/agent.js";

describe("agent daemon state", () => {
  test("queues submitted prompts and selects the next runnable task", () => {
    let state = buildDefaultDaemonState("demo", "codex");
    state = applyAgentCommand(
      state,
      createAgentCommand({
        payload: { priority: 2, prompt: "triage flaky tests" },
        type: "submit",
      }),
    );
    state = applyAgentCommand(
      state,
      createAgentCommand({
        payload: { priority: 0, prompt: "update docs" },
        type: "submit",
      }),
    );

    const next = selectRunnableTask(state);

    expect(next?.prompt).toBe("triage flaky tests");
    expect(state.tasks).toHaveLength(2);
  });

  test("backs off when load or peer agents exceed policy", () => {
    const policy = buildDefaultResourcePolicy(8);
    const blocked = assessAgentResources(
      {
        cpuCount: 8,
        freeMemoryBytes: 512,
        freeMemoryRatio: 0.1,
        load1: 8,
        load15: 6,
        load5: 7,
        peerAgentCount: 3,
        sampledAt: new Date().toISOString(),
      },
      policy,
    );

    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons.join(" ")).toContain("low free memory");
    expect(blocked.reasons.join(" ")).toContain("peer Latte agents");
  });

  test("detects transient provider-side sandbox failures", () => {
    const message =
      "I couldn't write the file because bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted.";

    expect(detectTransientFailureSignature(message)).toBe(
      "provider sandbox failure",
    );
  });

  test("requeues tasks before marking them failed", () => {
    let state = buildDefaultDaemonState("demo", "codex");
    state = applyAgentCommand(
      state,
      createAgentCommand({
        payload: { prompt: "stress the harness" },
        type: "submit",
      }),
    );
    const task = selectRunnableTask(state);
    expect(task).toBeDefined();

    state = markTaskRunning(state, task!.id, "2026-04-16T00:00:00.000Z");
    state = markTaskRetry(
      state,
      task!.id,
      "resource contention",
      1,
      "2026-04-16T00:00:01.000Z",
    );
    expect(
      state.tasks.find((candidate) => candidate.id === task!.id)?.status,
    ).toBe("queued");

    state = markTaskRunning(state, task!.id, "2026-04-16T00:01:00.000Z");
    state = markTaskRetry(
      state,
      task!.id,
      "resource contention",
      1,
      "2026-04-16T00:01:01.000Z",
    );
    state = markTaskRunning(state, task!.id, "2026-04-16T00:02:00.000Z");
    state = markTaskRetry(
      state,
      task!.id,
      "resource contention",
      1,
      "2026-04-16T00:02:01.000Z",
    );
    state = markTaskRunning(state, task!.id, "2026-04-16T00:03:00.000Z");
    state = markTaskRetry(
      state,
      task!.id,
      "resource contention",
      1,
      "2026-04-16T00:03:01.000Z",
    );

    expect(
      state.tasks.find((candidate) => candidate.id === task!.id)?.status,
    ).toBe("failed");
  });
});

describe("FileAgentStore", () => {
  test("persists and acknowledges queued commands", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "latte-agent-"));
    const store = new FileAgentStore(projectRoot);
    await store.ensureState("demo", "codex");
    await store.enqueueCommand(
      createAgentCommand({
        payload: { prompt: "index boba" },
        type: "submit",
      }),
    );

    const commands = await store.listPendingCommands();

    expect(commands).toHaveLength(1);
    await store.acknowledgeCommand(commands[0]!.path);
    expect(await store.listPendingCommands()).toHaveLength(0);
  });
});
