import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  buildDefaultDaemonState,
  FileCronStore,
  markTaskCompleted,
  markTaskRunning,
} from "../packages/core/src/index.js";

describe("cron manager", () => {
  test("keeps concurrent job registrations", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "latte-cron-"));
    const store = new FileCronStore(projectRoot);

    await Promise.all(
      Array.from({ length: 20 }, async (_, index) =>
        store.addJob({
          name: `job-${index}`,
          prompt: `run job ${index}`,
          schedule: { everyMs: 60_000, kind: "interval" },
          sessionTarget: { kind: "isolated" },
        }),
      ),
    );

    await expect(store.listJobs()).resolves.toHaveLength(20);
  });

  test("claims a due one-shot job only once under concurrent ticks", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "latte-cron-"));
    const store = new FileCronStore(projectRoot);
    const now = new Date("2026-05-04T00:00:00.000Z");
    await store.addJob({
      name: "singleton",
      prompt: "run once",
      schedule: { at: now.toISOString(), kind: "at" },
      sessionTarget: { kind: "isolated" },
    });

    const ticks = await Promise.all(
      Array.from({ length: 4 }, async () =>
        store.enqueueDueJobs(buildDefaultDaemonState("demo", "codex"), {
          maxConcurrentRuns: 4,
          now,
          projectKey: "demo",
          provider: "codex",
        }),
      ),
    );

    expect(ticks.flatMap((tick) => tick.enqueued)).toHaveLength(1);
    await expect(store.listRuns()).resolves.toHaveLength(1);
  });

  test("enqueues due jobs with isolated session keys and reconciles runs", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "latte-cron-"));
    const store = new FileCronStore(projectRoot);
    const now = new Date("2026-05-04T00:00:00.000Z");
    const first = await store.addJob({
      name: "first",
      prompt: "run first isolated job",
      schedule: { at: now.toISOString(), kind: "at" },
      sessionTarget: { kind: "isolated" },
    });
    await store.addJob({
      name: "second",
      prompt: "run second isolated job",
      schedule: { at: now.toISOString(), kind: "at" },
      sessionTarget: { kind: "isolated" },
    });

    let state = buildDefaultDaemonState("demo", "codex");
    const tick = await store.enqueueDueJobs(state, {
      maxConcurrentRuns: 1,
      now,
      projectKey: "demo",
      provider: "codex",
    });
    state = tick.state;

    expect(tick.enqueued).toHaveLength(1);
    expect(tick.skipped).toHaveLength(1);
    expect(tick.enqueued[0]?.sessionKey).toContain(`cron:${first.id}`);
    expect(state.tasks[0]?.origin?.kind).toBe("cron");

    const task = state.tasks[0]!;
    state = markTaskRunning(state, task.id, "2026-05-04T00:00:01.000Z");
    state = markTaskCompleted(state, task.id, "2026-05-04T00:00:02.000Z");
    await store.reconcileWithAgentState(state);

    const runs = await store.listRuns();
    expect(runs.some((run) => run.status === "succeeded")).toBe(true);
    expect(runs.some((run) => run.status === "skipped")).toBe(true);
  });
});
